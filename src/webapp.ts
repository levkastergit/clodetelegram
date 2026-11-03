import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express, { type Request, type Response, type NextFunction } from "express";
import {
  BOT_TOKEN,
  GITHUB_USER,
  GUEST_PROJECT,
  PORT,
  PROJECTS_DIR,
  isGuestUser,
  isOwnerUser,
} from "./config.js";
import {
  createTab,
  cwdForTab,
  ensureGuestState,
  getTab,
  getUserState,
  guestProjectEntry,
  isValidSessionId,
  listPastSessions,
  listProjects,
  readSessionHistory,
  removeTab,
  sanitizeFileName,
  sanitizeProjectName,
  saveState,
  type ChatTab,
  type ProjectEntry,
} from "./state.js";
import {
  getLimits,
  isTabRunning,
  runTurn,
  stopTab,
  type AskQuestion,
  type TurnIO,
} from "./claude.js";

const execFileAsync = promisify(execFile);

// ---------- Проверка initData мини-приложения ----------
// Алгоритм из документации Telegram: https://core.telegram.org/bots/webapps

type AuthUser = { id: number; username?: string; firstName?: string };

function validateInitData(raw: string): AuthUser | null {
  if (!raw) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computed = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 24 * 60 * 60) return null;
  try {
    const u = JSON.parse(params.get("user") ?? "") as {
      id?: number;
      username?: string;
      first_name?: string;
    };
    if (!u || typeof u.id !== "number") return null;
    return { id: u.id, username: u.username, firstName: u.first_name };
  } catch {
    return null;
  }
}

type AuthInfo = { user: AuthUser; role: "owner" | "guest" };

function authenticate(req: Request): AuthInfo | null {
  const raw =
    (req.headers["x-tg-init-data"] as string | undefined) ??
    (typeof req.query.auth === "string" ? req.query.auth : "");
  const user = validateInitData(raw);
  if (!user) return null;
  if (isOwnerUser(user)) return { user, role: "owner" };
  if (isGuestUser(user)) {
    ensureGuestState(user.id);
    return { user, role: "guest" };
  }
  return null;
}

// ---------- SSE: события для открытых вкладок мини-приложения ----------

const sseClients = new Map<number, Set<Response>>();

function pushEvent(userId: number, event: Record<string, unknown>): void {
  const set = sseClients.get(userId);
  if (!set) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    res.write(data);
  }
}

// ---------- Ожидающие подтверждения и вопросы (на вкладку) ----------

type PendingApproval = {
  userId: number;
  tabId: string;
  description: string;
  resolve: (allowed: boolean) => void;
};
const pendingApprovals = new Map<string, PendingApproval>();

type PendingQuestion = {
  userId: number;
  tabId: string;
  q: AskQuestion;
  resolve: (answer: string | null) => void;
};
const pendingQuestions = new Map<string, PendingQuestion>();
const activeQuestionByTab = new Map<string, string>();

let idCounter = 0;

function ioFor(userId: number, tabId: string): TurnIO {
  return {
    status(text) {
      pushEvent(userId, { type: "status", tab: tabId, text });
    },
    askApproval(description, signal) {
      return new Promise<boolean>((outerResolve) => {
        const id = String(++idCounter);
        let settled = false;
        const finish = (allowed: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingApprovals.delete(id);
          pushEvent(userId, { type: "approval_done", tab: tabId, id, allowed });
          outerResolve(allowed);
        };
        const timer = setTimeout(() => finish(false), 10 * 60 * 1000);
        signal.addEventListener("abort", () => finish(false));
        pendingApprovals.set(id, { userId, tabId, description, resolve: finish });
        pushEvent(userId, { type: "approval", tab: tabId, id, description });
      });
    },
    askQuestion(q, signal) {
      return new Promise<string | null>((outerResolve) => {
        const id = String(++idCounter);
        let settled = false;
        const finish = (answer: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingQuestions.delete(id);
          if (activeQuestionByTab.get(tabId) === id) {
            activeQuestionByTab.delete(tabId);
          }
          pushEvent(userId, { type: "question_done", tab: tabId, id, answer });
          outerResolve(answer);
        };
        const timer = setTimeout(() => finish(null), 10 * 60 * 1000);
        signal.addEventListener("abort", () => finish(null));
        pendingQuestions.set(id, { userId, tabId, q, resolve: finish });
        activeQuestionByTab.set(tabId, id);
        pushEvent(userId, {
          type: "question",
          tab: tabId,
          id,
          question: q.question,
          header: q.header,
          multi: Boolean(q.multiSelect),
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
        });
      });
    },
  };
}

function startTurn(userId: number, tab: ChatTab, text: string): void {
  const cs = getUserState(userId);
  // Название вкладки — первая реплика пользователя
  if (tab.title === "Новый диалог") {
    tab.title = text.length > 48 ? text.slice(0, 48) + "…" : text;
    saveState();
    pushEvent(userId, { type: "tab_title", tab: tab.id, title: tab.title });
  }
  pushEvent(userId, { type: "turn_started", tab: tab.id });
  void runTurn(userId, cs, tab, text, ioFor(userId, tab.id)).then((r) => {
    pushEvent(userId, { type: "done", tab: tab.id, ...r });
  });
}

function tabSummary(tab: ChatTab): Record<string, unknown> {
  const qid = activeQuestionByTab.get(tab.id);
  const question = qid ? pendingQuestions.get(qid) : undefined;
  const approval = [...pendingApprovals.entries()].find(
    ([, p]) => p.tabId === tab.id
  );
  return {
    id: tab.id,
    title: tab.title,
    project: tab.project ?? null,
    running: isTabRunning(tab.id),
    updatedAt: tab.updatedAt,
    pending: {
      approval: approval
        ? { id: approval[0], description: approval[1].description }
        : null,
      question:
        qid && question
          ? {
              id: qid,
              question: question.q.question,
              multi: Boolean(question.q.multiSelect),
              options: question.q.options,
            }
          : null,
    },
  };
}

// Поиск проекта по имени; для гостя разрешён только его проект
async function resolveProject(
  role: "owner" | "guest",
  name: string
): Promise<ProjectEntry | undefined> {
  if (role === "guest") {
    return name === GUEST_PROJECT ? guestProjectEntry() : undefined;
  }
  return (await listProjects()).find((p) => p.name === name);
}

// ---------- HTTP-сервер ----------

export function startWebApp(): void {
  const app = express();
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));

  app.use(express.static(publicDir));
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const auth = authenticate(req);
    if (!auth) {
      res.status(401).json({ error: "Откройте приложение из Telegram." });
      return;
    }
    res.locals.auth = auth;
    next();
  });

  const authOf = (res: Response): AuthInfo => res.locals.auth as AuthInfo;

  // Поток событий (EventSource не умеет заголовки — auth передаётся в query)
  app.get("/api/events", (req, res) => {
    const { user } = authOf(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":connected\n\n");
    let set = sseClients.get(user.id);
    if (!set) {
      set = new Set();
      sseClients.set(user.id, set);
    }
    set.add(res);
    const heartbeat = setInterval(() => res.write(":hb\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (set.size === 0) sseClients.delete(user.id);
    });
  });

  app.get("/api/me", (_req, res) => {
    const { user, role } = authOf(res);
    const cs = getUserState(user.id);
    res.json({
      user: { id: user.id, name: user.firstName ?? user.username ?? String(user.id) },
      role,
      settings: { auto: Boolean(cs.auto), model: cs.model ?? null },
      tabs: cs.tabs.map(tabSummary),
      activeTabId: cs.activeTabId ?? null,
    });
  });

  app.get("/api/projects", async (_req, res) => {
    const { role } = authOf(res);
    if (role === "guest") {
      res.json({ projects: [{ name: GUEST_PROJECT, local: true }] });
      return;
    }
    try {
      const projects = await listProjects();
      res.json({
        projects: projects.map((p) => ({ name: p.name, local: Boolean(p.dir) })),
      });
    } catch (err) {
      res.status(502).json({
        error:
          "Не удалось получить список репозиториев с GitHub: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // Прошлые диалоги проекта (гостю — только свои)
  app.get("/api/project-sessions", async (req, res) => {
    const { user, role } = authOf(res);
    const name = typeof req.query.name === "string" ? req.query.name : "";
    const cs = getUserState(user.id);
    const entry = await resolveProject(role, name).catch(() => undefined);
    if (!entry || !entry.dir || !fs.existsSync(entry.dir)) {
      res.json({ sessions: [] });
      return;
    }
    const past = listPastSessions(
      entry.dir,
      10,
      cs.guest ? new Set(cs.ownedSessions ?? []) : undefined
    );
    res.json({
      sessions: past.map((s) => ({
        id: s.id,
        title: s.title,
        mtime: s.mtime.toISOString(),
      })),
    });
  });

  // Новая вкладка-сессия: {project?: имя|null, resume?: id прошлого диалога,
  // newProject?: имя новой папки}
  app.post("/api/tab", async (req, res) => {
    const { user, role } = authOf(res);
    const cs = getUserState(user.id);
    const body = (req.body ?? {}) as {
      project?: string | null;
      resume?: string | null;
      newProject?: string;
    };

    // Новый проект (папка) — только владелец
    if (body.newProject) {
      if (role !== "owner") {
        res.status(403).json({ error: "Недоступно для гостевого аккаунта." });
        return;
      }
      const name = sanitizeProjectName(body.newProject);
      if (!name) {
        res.status(400).json({ error: "Название пустое." });
        return;
      }
      const dir = path.join(PROJECTS_DIR, name);
      fs.mkdirSync(dir, { recursive: true });
      const tab = createTab(cs, { title: name, project: name, projectDir: dir });
      res.json({ tab: tabSummary(tab) });
      return;
    }

    // Обычный чат без проекта — только владелец
    if (!body.project) {
      if (role !== "owner") {
        res.status(403).json({ error: "Недоступно для гостевого аккаунта." });
        return;
      }
      const tab = createTab(cs, { title: "Новый диалог" });
      res.json({ tab: tabSummary(tab) });
      return;
    }

    let entry: ProjectEntry | undefined;
    try {
      entry = await resolveProject(role, body.project);
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!entry) {
      res.status(404).json({ error: "Проект не найден." });
      return;
    }

    let projectDir = entry.dir;
    if (projectDir && !fs.existsSync(projectDir)) {
      res.status(404).json({ error: `Папка проекта не найдена: ${projectDir}` });
      return;
    }
    if (!projectDir) {
      // Репозитория нет на диске — клонируем с GitHub
      const target = path.join(PROJECTS_DIR, entry.name);
      try {
        await execFileAsync(
          "git",
          ["clone", `https://github.com/${GITHUB_USER}/${entry.name}.git`, target],
          { timeout: 5 * 60 * 1000 }
        );
        projectDir = target;
      } catch (err) {
        console.error("Ошибка клонирования:", err);
        res.status(500).json({
          error:
            `Не удалось склонировать ${entry.name}: ` +
            (err instanceof Error ? err.message : String(err)),
        });
        return;
      }
    }

    let resume: string | undefined;
    let title = "Новый диалог";
    if (body.resume) {
      if (typeof body.resume !== "string" || !isValidSessionId(body.resume)) {
        res.status(400).json({ error: "Некорректный id диалога." });
        return;
      }
      if (cs.guest && !(cs.ownedSessions ?? []).includes(body.resume)) {
        res.status(403).json({ error: "Этот диалог недоступен." });
        return;
      }
      resume = body.resume;
      const past = listPastSessions(projectDir, 50).find((s) => s.id === resume);
      if (past) {
        title = past.title.length > 48 ? past.title.slice(0, 48) + "…" : past.title;
      }
    }

    const tab = createTab(cs, {
      title,
      project: entry.name,
      projectDir,
      claudeSessionId: resume,
    });
    res.json({ tab: tabSummary(tab) });
  });

  // Сделать вкладку активной (запоминается на сервере)
  app.post("/api/activate", (req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    const tab = getTab(cs, String(req.body?.id ?? ""));
    if (!tab) {
      res.status(404).json({ error: "Сессия не найдена." });
      return;
    }
    cs.activeTabId = tab.id;
    saveState();
    res.json({ ok: true });
  });

  // Закрыть вкладку (историю Claude это не удаляет — диалог можно продолжить
  // позже через выбор прошлых диалогов проекта)
  app.delete("/api/tab/:id", (req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    const tab = getTab(cs, req.params.id);
    if (!tab) {
      res.status(404).json({ error: "Сессия не найдена." });
      return;
    }
    stopTab(tab.id);
    removeTab(cs, tab.id);
    res.json({ ok: true, activeTabId: cs.activeTabId ?? null });
  });

  // История вкладки для отрисовки чата
  app.get("/api/history", (req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    const tab = getTab(cs, String(req.query.tab ?? ""));
    if (!tab || !tab.claudeSessionId) {
      res.json({ messages: [] });
      return;
    }
    res.json({ messages: readSessionHistory(cwdForTab(tab), tab.claudeSessionId) });
  });

  // Отправка сообщения во вкладку (или ответ на активный вопрос в ней)
  app.post("/api/message", (req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    const tab = getTab(cs, String(req.body?.tab ?? ""));
    if (!tab) {
      res.status(404).json({ error: "Сессия не найдена." });
      return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "Пустое сообщение." });
      return;
    }
    const qid = activeQuestionByTab.get(tab.id);
    if (qid) {
      const pq = pendingQuestions.get(qid);
      if (pq && pq.userId === user.id) {
        pq.resolve(text);
        res.json({ ok: true, answeredQuestion: true });
        return;
      }
    }
    if (isTabRunning(tab.id)) {
      res.status(409).json({ error: "В этой сессии задача ещё выполняется." });
      return;
    }
    startTurn(user.id, tab, text);
    res.json({ ok: true });
  });

  app.post("/api/stop", (req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    const tab = getTab(cs, String(req.body?.tab ?? ""));
    if (!tab) {
      res.status(404).json({ error: "Сессия не найдена." });
      return;
    }
    res.json({ stopped: stopTab(tab.id) });
  });

  app.post("/api/approve", (req, res) => {
    const { user } = authOf(res);
    const id = String(req.body?.id ?? "");
    const pending = pendingApprovals.get(id);
    if (!pending || pending.userId !== user.id) {
      res.status(404).json({ error: "Этот запрос уже неактуален." });
      return;
    }
    pending.resolve(Boolean(req.body?.allowed));
    res.json({ ok: true });
  });

  app.post("/api/answer", (req, res) => {
    const { user } = authOf(res);
    const id = String(req.body?.id ?? "");
    const pending = pendingQuestions.get(id);
    if (!pending || pending.userId !== user.id) {
      res.status(404).json({ error: "Этот вопрос уже неактуален." });
      return;
    }
    const answer = typeof req.body?.answer === "string" ? req.body.answer : "";
    if (!answer) {
      res.status(400).json({ error: "Пустой ответ." });
      return;
    }
    pending.resolve(answer);
    res.json({ ok: true });
  });

  app.post("/api/settings", (req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    if (typeof req.body?.auto === "boolean") {
      cs.auto = req.body.auto;
    }
    if ("model" in (req.body ?? {})) {
      const m = req.body.model;
      if (m === null || m === "") {
        cs.model = undefined;
      } else if (m === "opus" || m === "sonnet" || m === "haiku") {
        cs.model = m;
      }
    }
    saveState();
    res.json({ auto: Boolean(cs.auto), model: cs.model ?? null });
  });

  // Лимиты подписки — только владельцу (личные данные)
  app.get("/api/limits", async (_req, res) => {
    const { role } = authOf(res);
    if (role !== "owner") {
      res.status(403).json({ error: "Недоступно для гостевого аккаунта." });
      return;
    }
    try {
      res.json(await getLimits());
    } catch (err) {
      console.error("Ошибка запроса лимитов:", err);
      res.status(500).json({
        error:
          "Не удалось получить лимиты: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // Загрузка файла во вкладку: тело — байты, имя и вкладка — в query
  app.post(
    "/api/upload",
    express.raw({ type: "*/*", limit: "50mb" }),
    (req, res) => {
      const { user } = authOf(res);
      const cs = getUserState(user.id);
      const tab = getTab(cs, String(req.query.tab ?? ""));
      if (!tab) {
        res.status(404).json({ error: "Сессия не найдена." });
        return;
      }
      const name = sanitizeFileName(
        typeof req.query.name === "string" ? req.query.name : `file_${Date.now()}`
      );
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "Пустой файл." });
        return;
      }
      const dir = path.join(cwdForTab(tab), "_incoming");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, req.body);
      res.json({ path: dest, name });
    }
  );

  app.listen(PORT, () => {
    console.log(`Мини-приложение: http://localhost:${PORT}`);
  });
}
