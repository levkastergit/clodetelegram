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
  GUEST_PROJECT_DIR,
  PORT,
  PROJECTS_DIR,
  isGuestUser,
  isOwnerUser,
} from "./config.js";
import {
  cwdFor,
  ensureGuestState,
  getUserState,
  listPastSessions,
  listProjects,
  readSessionHistory,
  sanitizeFileName,
  sanitizeProjectName,
  saveState,
  sessionKey,
  type ProjectEntry,
} from "./state.js";
import {
  getLimitsLines,
  isRunning,
  runTurn,
  stopTurn,
  type AskQuestion,
  type TurnIO,
} from "./claude.js";

const execFileAsync = promisify(execFile);

// ---------- Проверка initData мини-приложения ----------
// Алгоритм из документации Telegram: https://core.telegram.org/bots/webapps
// secret = HMAC_SHA256(bot_token, key="WebAppData"),
// hash = hex(HMAC_SHA256(data_check_string, secret)).

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
  // подпись не старше 24 часов — иначе требуем переоткрыть приложение
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

// ---------- Ожидающие подтверждения и вопросы ----------

type PendingApproval = {
  userId: number;
  description: string;
  resolve: (allowed: boolean) => void;
};
const pendingApprovals = new Map<string, PendingApproval>();

type PendingQuestion = {
  userId: number;
  q: AskQuestion;
  resolve: (answer: string | null) => void;
};
const pendingQuestions = new Map<string, PendingQuestion>();
const activeQuestionByUser = new Map<number, string>();

let idCounter = 0;

function ioFor(userId: number): TurnIO {
  return {
    status(text) {
      pushEvent(userId, { type: "status", text });
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
          pushEvent(userId, { type: "approval_done", id, allowed });
          outerResolve(allowed);
        };
        const timer = setTimeout(() => finish(false), 10 * 60 * 1000);
        signal.addEventListener("abort", () => finish(false));
        pendingApprovals.set(id, { userId, description, resolve: finish });
        pushEvent(userId, { type: "approval", id, description });
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
          if (activeQuestionByUser.get(userId) === id) {
            activeQuestionByUser.delete(userId);
          }
          pushEvent(userId, { type: "question_done", id, answer });
          outerResolve(answer);
        };
        const timer = setTimeout(() => finish(null), 10 * 60 * 1000);
        signal.addEventListener("abort", () => finish(null));
        pendingQuestions.set(id, { userId, q, resolve: finish });
        activeQuestionByUser.set(userId, id);
        pushEvent(userId, {
          type: "question",
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

function startTurn(userId: number, text: string): void {
  void runTurn(userId, text, ioFor(userId)).then((r) => {
    pushEvent(userId, { type: "done", ...r });
  });
}

// ---------- HTTP-сервер ----------

export function startWebApp(): void {
  const app = express();
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));

  app.use(express.static(publicDir));
  app.use(express.json({ limit: "1mb" }));

  // Все /api/* требуют подписанный initData из Telegram
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
    const approval = [...pendingApprovals.entries()].find(
      ([, p]) => p.userId === user.id
    );
    const qid = activeQuestionByUser.get(user.id);
    const question = qid ? pendingQuestions.get(qid) : undefined;
    res.json({
      user: { id: user.id, name: user.firstName ?? user.username ?? String(user.id) },
      role,
      state: {
        mode: cs.mode,
        project: cs.project ?? null,
        auto: Boolean(cs.auto),
        model: cs.model ?? null,
      },
      running: isRunning(user.id),
      hasSession: Boolean(cs.sessions[sessionKey(cs)]),
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
    });
  });

  app.get("/api/projects", async (_req, res) => {
    const { user, role } = authOf(res);
    if (role === "guest") {
      res.json({
        projects: [{ name: GUEST_PROJECT, local: true }],
        current: getUserState(user.id).project ?? null,
      });
      return;
    }
    try {
      const projects = await listProjects();
      res.json({
        projects: projects.map((p) => ({ name: p.name, local: Boolean(p.dir) })),
        current:
          getUserState(user.id).mode === "project"
            ? getUserState(user.id).project ?? null
            : null,
      });
    } catch (err) {
      res.status(502).json({
        error:
          "Не удалось получить список репозиториев с GitHub: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // Выбор проекта; при необходимости клонирует репозиторий с GitHub
  app.post("/api/project", async (req, res) => {
    const { user, role } = authOf(res);
    if (isRunning(user.id)) {
      res.status(409).json({ error: "Дождитесь конца текущей задачи или нажмите «Стоп»." });
      return;
    }
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const cs = getUserState(user.id);

    let entry: ProjectEntry | undefined;
    if (role === "guest") {
      if (name !== GUEST_PROJECT) {
        res.status(403).json({ error: "Этот проект недоступен." });
        return;
      }
      entry = { name: GUEST_PROJECT, dir: GUEST_PROJECT_DIR };
    } else {
      try {
        entry = (await listProjects()).find((p) => p.name === name);
      } catch (err) {
        res.status(502).json({
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
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

    cs.mode = "project";
    cs.project = entry.name;
    cs.projectDir = projectDir;
    saveState();

    // Прошлые диалоги; гостю — только начатые им самим
    const past = listPastSessions(
      projectDir,
      10,
      cs.guest ? new Set(cs.ownedSessions ?? []) : undefined
    );
    res.json({
      project: entry.name,
      sessions: past.map((s) => ({
        id: s.id,
        title: s.title,
        mtime: s.mtime.toISOString(),
      })),
    });
  });

  // Создание нового проекта (только владелец)
  app.post("/api/project/new", (req, res) => {
    const { user, role } = authOf(res);
    if (role !== "owner") {
      res.status(403).json({ error: "Недоступно для гостевого аккаунта." });
      return;
    }
    const name = sanitizeProjectName(
      typeof req.body?.name === "string" ? req.body.name : ""
    );
    if (!name) {
      res.status(400).json({ error: "Название пустое." });
      return;
    }
    const dir = path.join(PROJECTS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    const cs = getUserState(user.id);
    cs.mode = "project";
    cs.project = name;
    cs.projectDir = dir;
    saveState();
    res.json({ project: name });
  });

  // Обычный чат без проекта (только владелец)
  app.post("/api/chat", (_req, res) => {
    const { user, role } = authOf(res);
    if (role !== "owner") {
      res.status(403).json({ error: "Недоступно для гостевого аккаунта." });
      return;
    }
    const cs = getUserState(user.id);
    cs.mode = "chat";
    saveState();
    res.json({ ok: true });
  });

  // Выбор прошлого диалога (id) или нового (id = null)
  app.post("/api/session", (req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    const key = sessionKey(cs);
    const id = req.body?.id;
    if (id === null || id === undefined || id === "") {
      delete cs.sessions[key];
      saveState();
      res.json({ ok: true });
      return;
    }
    if (typeof id !== "string" || !/^[\w.-]+$/.test(id)) {
      res.status(400).json({ error: "Некорректный id сессии." });
      return;
    }
    if (cs.guest && !(cs.ownedSessions ?? []).includes(id)) {
      res.status(403).json({ error: "Этот диалог недоступен." });
      return;
    }
    cs.sessions[key] = id;
    saveState();
    res.json({ ok: true });
  });

  // История текущего диалога для отрисовки чата
  app.get("/api/history", (_req, res) => {
    const { user } = authOf(res);
    const cs = getUserState(user.id);
    const id = cs.sessions[sessionKey(cs)];
    if (!id) {
      res.json({ messages: [] });
      return;
    }
    res.json({ messages: readSessionHistory(cwdFor(cs), id) });
  });

  // Отправка сообщения Клоду (или ответ на активный вопрос)
  app.post("/api/message", (req, res) => {
    const { user } = authOf(res);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "Пустое сообщение." });
      return;
    }
    // Если Клод ждёт ответа на вопрос — текст считается ответом
    const qid = activeQuestionByUser.get(user.id);
    if (qid) {
      const pq = pendingQuestions.get(qid);
      if (pq) {
        pq.resolve(text);
        res.json({ ok: true, answeredQuestion: true });
        return;
      }
    }
    if (isRunning(user.id)) {
      res.status(409).json({ error: "Предыдущая задача ещё выполняется." });
      return;
    }
    startTurn(user.id, text);
    res.json({ ok: true });
  });

  app.post("/api/stop", (_req, res) => {
    const { user } = authOf(res);
    res.json({ stopped: stopTurn(user.id) });
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
      res.json({ lines: await getLimitsLines() });
    } catch (err) {
      console.error("Ошибка запроса лимитов:", err);
      res.status(500).json({
        error:
          "Не удалось получить лимиты: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // Загрузка файла: тело запроса — сами байты, имя — в query (?name=)
  app.post(
    "/api/upload",
    express.raw({ type: "*/*", limit: "50mb" }),
    (req, res) => {
      const { user } = authOf(res);
      const cs = getUserState(user.id);
      const cwd = cwdFor(cs);
      const name = sanitizeFileName(
        typeof req.query.name === "string" ? req.query.name : `file_${Date.now()}`
      );
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "Пустой файл." });
        return;
      }
      const dir = path.join(cwd, "_incoming");
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
