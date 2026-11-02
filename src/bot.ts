import "dotenv/config";
import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import {
  query,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------- Конфигурация ----------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Список разрешённых Telegram ID через запятую (ALLOWED_USER_IDS=111,222).
// Старое имя ALLOWED_USER_ID с одним ID тоже работает.
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USER_ID || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
);
// Корневая папка с папками проектов (например, рабочий стол с git-репозиториями)
const PROJECTS_DIR =
  process.env.PROJECTS_DIR ||
  process.env.WORKING_DIR ||
  path.join(process.cwd(), "workspace");
// Папка обычного чата — отдельно, чтобы не засорять папку проектов
const CHAT_DIR =
  process.env.CHAT_DIR || path.join(process.cwd(), "workspace", "_chat");
// Аккаунт GitHub: список проектов = репозитории этого аккаунта
const GITHUB_USER = process.env.GITHUB_USER || "levkastergit";
// Дополнительные проекты — абсолютные пути через точку с запятой
const EXTRA_PROJECTS = (process.env.EXTRA_PROJECTS || "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error("Ошибка: TELEGRAM_BOT_TOKEN не задан. Скопируйте .env.example в .env и заполните.");
  process.exit(1);
}

// Режим настройки: ID не заданы — бот не даёт доступа к Клоду,
// а только сообщает написавшему его Telegram ID для заполнения .env.
const SETUP_MODE = ALLOWED_USER_IDS.size === 0;
if (SETUP_MODE) {
  console.warn(
    "ALLOWED_USER_IDS пуст — запускаюсь в режиме настройки: отвечаю любому его же ID, доступа к Клоду нет."
  );
}

// Пользователь выбрал работу через подписку Claude (Pro/Max).
// Если в окружении есть ANTHROPIC_API_KEY, он имел бы приоритет над подпиской —
// убираем его, чтобы случайно не тратить деньги через API.
if (process.env.ANTHROPIC_API_KEY) {
  console.warn("ANTHROPIC_API_KEY найден в окружении — игнорирую его, используется подписка Claude.");
  delete process.env.ANTHROPIC_API_KEY;
}

fs.mkdirSync(CHAT_DIR, { recursive: true });

// ---------- Состояние чатов (режим, проект, сессии) ----------

type ChatState = {
  mode: "chat" | "project";
  project?: string;
  // Абсолютный путь папки проекта; для старых записей отсутствует —
  // тогда берётся PROJECTS_DIR/<project>
  projectDir?: string;
  // Авто-режим: все действия Клода одобряются без кнопок подтверждения
  auto?: boolean;
  // Модель: "opus" | "sonnet" | "haiku"; не задано — модель по умолчанию
  model?: string;
  // ключ: "chat" или "project:<имя>" -> session_id Клода
  sessions: Record<string, string>;
};

const STATE_FILE = path.join(process.cwd(), "state.json");

function loadState(): Record<string, ChatState> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();

function getChatState(chatId: number): ChatState {
  const key = String(chatId);
  if (!state[key]) {
    state[key] = { mode: "chat", sessions: {} };
  }
  return state[key];
}

function sessionKey(cs: ChatState): string {
  return cs.mode === "project" && cs.project ? `project:${cs.project}` : "chat";
}

function cwdFor(cs: ChatState): string {
  if (cs.mode === "project" && cs.project) {
    return cs.projectDir || path.join(PROJECTS_DIR, cs.project);
  }
  return CHAT_DIR;
}

function modeLabel(cs: ChatState): string {
  return cs.mode === "project" && cs.project
    ? `проект «${cs.project}»`
    : "обычный чат (без проекта)";
}

// ---------- Проекты ----------

// Проект = репозиторий аккаунта GitHub или дополнительный локальный путь.
// dir — абсолютный путь папки на диске, если она уже есть.
type ProjectEntry = { name: string; dir?: string };

function localDirs(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const e of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith(".")) {
        map.set(e.name.toLowerCase(), e.name);
      }
    }
  } catch {
    // папки нет — вернём пустую карту
  }
  return map;
}

async function listProjects(): Promise<ProjectEntry[]> {
  const res = await fetch(
    `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=pushed`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub API: ${res.status} ${res.statusText}`);
  }
  const repos = (await res.json()) as { name: string }[];
  const local = localDirs();
  const entries: ProjectEntry[] = repos.map((r) => {
    const localName = local.get(r.name.toLowerCase());
    return {
      name: r.name,
      dir: localName ? path.join(PROJECTS_DIR, localName) : undefined,
    };
  });
  // Дополнительные проекты по абсолютным путям (вне GitHub)
  for (const p of EXTRA_PROJECTS) {
    entries.push({ name: path.basename(p), dir: p });
  }
  return entries;
}

function sanitizeProjectName(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 60);
}

// ---------- Состояние выполнения ----------

type RunState = {
  abortController: AbortController;
  statusMessageId?: number;
  lastStatusEdit: number;
};

const running = new Map<number, RunState>(); // chatId -> состояние

type PendingApproval = {
  resolve: (allowed: boolean) => void;
};
const pendingApprovals = new Map<string, PendingApproval>();
let approvalCounter = 0;

// Вопросы Клода с вариантами ответа (инструмент AskUserQuestion)
type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

type PendingQuestion = {
  resolve: (answer: string | null) => void;
  options: string[];
  selected: Set<number>;
  multi: boolean;
};
const pendingQuestions = new Map<string, PendingQuestion>();
let questionCounter = 0;
// chatId -> id активного вопроса: позволяет ответить и обычным текстом
const activeQuestionByChat = new Map<number, string>();

// chatId -> список проектов, показанный последней инлайн-клавиатурой
const lastProjectList = new Map<number, ProjectEntry[]>();
// chatId -> список прошлых сессий, показанный после выбора проекта
const lastSessionList = new Map<number, SessionInfo[]>();

// ---------- Прошлые сессии Claude Code по папке проекта ----------
// Claude Code (и SDK, и Cursor) хранит диалоги в ~/.claude/projects/<папка>,
// где имя папки — путь проекта с заменой всех спецсимволов на дефисы.

type SessionInfo = { id: string; mtime: Date; title: string };

function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

// Читает начало файла сессии и достаёт первую реплику пользователя
function readSessionTitle(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          summary?: string;
          message?: { content?: unknown };
        };
        if (obj.type === "summary" && typeof obj.summary === "string") {
          return obj.summary;
        }
        if (obj.type === "user" && obj.message) {
          const c = obj.message.content;
          let text = "";
          if (typeof c === "string") text = c;
          else if (Array.isArray(c)) {
            const t = (c as { type?: string; text?: string }[]).find(
              (b) => b.type === "text" && typeof b.text === "string"
            );
            if (t?.text) text = t.text;
          }
          text = text.trim();
          if (text) return text;
        }
      } catch {
        // неполная строка в конце буфера — пропускаем
      }
    }
  } catch {
    // файл не прочитался — не критично
  }
  return "(без названия)";
}

function listPastSessions(projectDir: string, limit = 5): SessionInfo[] {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const encoded = encodeProjectDir(projectDir).toLowerCase();
  let dirName: string | undefined;
  try {
    dirName = fs
      .readdirSync(projectsRoot)
      .find((d) => d.toLowerCase() === encoded);
  } catch {
    return [];
  }
  if (!dirName) return [];
  const full = path.join(projectsRoot, dirName);
  let sessions: SessionInfo[];
  try {
    sessions = fs
      .readdirSync(full)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        id: f.slice(0, -".jsonl".length),
        mtime: fs.statSync(path.join(full, f)).mtime,
        title: "",
      }));
  } catch {
    return [];
  }
  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const top = sessions.slice(0, limit);
  for (const s of top) {
    s.title = readSessionTitle(path.join(full, `${s.id}.jsonl`));
  }
  return top;
}

function sessionButtonLabel(s: SessionInfo): string {
  const date = s.mtime.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const title = s.title.replace(/\s+/g, " ").slice(0, 40);
  return `${date} · ${title}`;
}
// чаты, от которых ждём название нового проекта
const awaitingProjectName = new Set<number>();

// ---------- Утилиты ----------

const TG_LIMIT = 4000; // лимит Telegram — 4096, берём с запасом

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TG_LIMIT) {
    // пытаемся резать по границе строки
    let cut = rest.lastIndexOf("\n", TG_LIMIT);
    if (cut < TG_LIMIT / 2) cut = TG_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

async function sendLong(ctx: Context, text: string): Promise<void> {
  for (const chunk of chunkText(text)) {
    await ctx.reply(chunk);
  }
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input.command === "string") {
    return `Bash: ${input.command}`;
  }
  if (typeof input.file_path === "string") {
    return `${name}: ${input.file_path}`;
  }
  const brief = JSON.stringify(input);
  return `${name}: ${brief.length > 200 ? brief.slice(0, 200) + "…" : brief}`;
}

// Показывает вопрос Клода кнопками в Telegram и ждёт выбор (или текст).
async function askQuestionViaTelegram(
  ctx: Context,
  chatId: number,
  q: AskQuestion,
  signal: AbortSignal
): Promise<string | null> {
  const qid = String(++questionCounter);
  const kb = new InlineKeyboard();
  q.options.forEach((o, i) => {
    kb.text(o.label.slice(0, 60), `qopt:${qid}:${i}`).row();
  });
  if (q.multiSelect) kb.text("✅ Готово", `qdone:${qid}`);

  const lines = [`❓ ${q.question}`];
  const described = q.options
    .filter((o) => o.description)
    .map((o) => `• ${o.label} — ${o.description}`);
  if (described.length > 0) lines.push("", ...described);
  lines.push(
    "",
    q.multiSelect
      ? "Можно выбрать несколько и нажать «Готово», либо написать свой ответ текстом."
      : "Нажмите кнопку либо напишите свой ответ текстом."
  );
  const msg = await ctx.reply(lines.join("\n"), { reply_markup: kb });

  return await new Promise<string | null>((outerResolve) => {
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingQuestions.delete(qid);
      if (activeQuestionByChat.get(chatId) === qid) activeQuestionByChat.delete(chatId);
      // убираем кнопки у сообщения с вопросом
      ctx.api.editMessageReplyMarkup(chatId, msg.message_id).catch(() => {});
      outerResolve(answer);
    };
    const timer = setTimeout(() => finish(null), 10 * 60 * 1000);
    signal.addEventListener("abort", () => finish(null));
    pendingQuestions.set(qid, {
      resolve: finish,
      options: q.options.map((o) => o.label),
      selected: new Set(),
      multi: Boolean(q.multiSelect),
    });
    activeQuestionByChat.set(chatId, qid);
  });
}

// Находит в финальном ответе нумерованный список «1. … 2. …» (2–10 пунктов)
function detectNumberedOptions(text: string): number[] {
  const nums: number[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d{1,2})[.)]\s+/.exec(line);
    if (m) nums.push(Number(m[1]));
  }
  const uniq = [...new Set(nums)];
  if (
    uniq.length >= 2 &&
    uniq.length <= 10 &&
    uniq[0] === 1 &&
    uniq.every((n, i) => n === i + 1)
  ) {
    return uniq;
  }
  return [];
}

// ---------- Кнопки ----------

const BTN_LIMITS = "📊 Лимиты";
const BTN_PROJECT = "📁 Проект";
const BTN_CHAT = "💬 Чат";
const BTN_SETTINGS = "⚙️ Настройки";
const MENU_BUTTONS = [BTN_LIMITS, BTN_PROJECT, BTN_CHAT, BTN_SETTINGS];

const mainKeyboard = new Keyboard()
  .text(BTN_PROJECT)
  .text(BTN_CHAT)
  .row()
  .text(BTN_LIMITS)
  .text(BTN_SETTINGS)
  .resized()
  .persistent();

// ---------- Настройки (авто-режим и модель) ----------

const MODEL_CHOICES: { label: string; value?: string }[] = [
  { label: "По умолч." },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

function settingsText(cs: ChatState): string {
  const model =
    MODEL_CHOICES.find((m) => m.value === cs.model)?.label ?? cs.model ?? "По умолч.";
  return (
    "⚙️ Настройки\n\n" +
    `Авто-режим: ${cs.auto ? "ВКЛ 🟢" : "ВЫКЛ ⚪"}\n` +
    "(в авто-режиме Клод выполняет команды без кнопок подтверждения; " +
    "вопросы с вариантами всё равно приходят кнопками)\n\n" +
    `Модель: ${model}`
  );
}

function settingsKeyboard(cs: ChatState): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(cs.auto ? "⏸ Выключить авто-режим" : "▶️ Включить авто-режим", "set:auto").row();
  for (const m of MODEL_CHOICES) {
    const current = (cs.model ?? undefined) === m.value;
    kb.text(`${current ? "✓ " : ""}${m.label}`, `set:model:${m.value ?? "default"}`);
  }
  return kb;
}

// ---------- Лимиты подписки ----------
// Используется экспериментальный метод SDK (shape может поменяться при обновлении
// пакета) — он возвращает те же данные, что экран /usage в Claude Code.

function progressBar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

function formatReset(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `, сброс ${d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatWindow(
  label: string,
  w: { utilization: number | null; resets_at: string | null } | null | undefined
): string | null {
  if (!w || w.utilization === null || w.utilization === undefined) return null;
  const pct = Math.round(w.utilization);
  return `${progressBar(pct)} ${pct}% — ${label}${formatReset(w.resets_at)}`;
}

async function handleLimits(ctx: Context): Promise<void> {
  const waitMsg = await ctx.reply("⏳ Запрашиваю лимиты…");
  // Метод живёт на объекте запроса, поэтому открываем минимальный query
  // и закрываем его сразу после ответа (persistSession: false — без следов).
  const q = query({
    prompt: "ping",
    options: { cwd: CHAT_DIR, maxTurns: 1, persistSession: false },
  });
  try {
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
    const rl = usage.rate_limits;
    if (!usage.rate_limits_available || !rl) {
      await ctx.reply(
        "Данные о лимитах недоступны (для этого способа входа план-лимиты не применяются)."
      );
      return;
    }
    const lines: string[] = [`Подписка: ${usage.subscription_type ?? "неизвестно"}`, ""];
    const windows = [
      formatWindow("сессия (5 ч)", rl.five_hour),
      formatWindow("неделя, все модели", rl.seven_day),
      formatWindow("неделя, Opus", rl.seven_day_opus),
      formatWindow("неделя, Sonnet", rl.seven_day_sonnet),
      ...(rl.model_scoped ?? []).map((m) =>
        formatWindow(`неделя, ${m.display_name}`, m)
      ),
    ].filter((l): l is string => l !== null);
    if (windows.length === 0) {
      lines.push("Сервер не вернул ни одного окна лимитов.");
    } else {
      lines.push(...windows);
    }
    if (rl.extra_usage?.is_enabled && rl.extra_usage.utilization !== null) {
      lines.push(
        `Доп. кредиты: использовано ${Math.round(rl.extra_usage.utilization ?? 0)}%` +
          (rl.extra_usage.used_credits !== null
            ? ` (${rl.extra_usage.used_credits} ${rl.extra_usage.currency ?? ""})`
            : "")
      );
    }
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    console.error("Ошибка запроса лимитов:", err);
    await ctx.reply(
      "Не удалось получить лимиты: " +
        (err instanceof Error ? err.message : String(err)) +
        "\n(функция опирается на экспериментальный API SDK — после обновления пакета она может потребовать правки)"
    );
  } finally {
    q.close();
    try {
      await ctx.api.deleteMessage(waitMsg.chat.id, waitMsg.message_id);
    } catch {
      // не критично
    }
  }
}

// ---------- Бот ----------

const bot = new Bot(BOT_TOKEN);

// Доступ только владельцу
bot.use(async (ctx, next) => {
  if (SETUP_MODE) {
    if (ctx.from && ctx.message) {
      console.log(`[настройка] Написал пользователь с ID: ${ctx.from.id}`);
      await ctx.reply(
        `Ваш Telegram ID: ${ctx.from.id}\n\n` +
          "Бот в режиме настройки. Добавьте этот ID в ALLOWED_USER_IDS в файле .env и перезапустите бота."
      );
    }
    return;
  }
  if (!ctx.from || !ALLOWED_USER_IDS.has(ctx.from.id)) {
    console.warn(`Отклонён запрос от чужого пользователя: ${ctx.from?.id}`);
    return;
  }
  if (ctx.message?.text) {
    console.log(`[tg] ${ctx.from.id}: ${ctx.message.text.slice(0, 80)}`);
  } else if (ctx.callbackQuery?.data) {
    console.log(`[tg] ${ctx.from.id} кнопка: ${ctx.callbackQuery.data}`);
  }
  await next();
});

bot.command("start", async (ctx) => {
  const cs = getChatState(ctx.chat.id);
  await ctx.reply(
    "Привет! Я мост между Telegram и Claude (Agent SDK).\n\n" +
      `Сейчас выбран: ${modeLabel(cs)}\n` +
      `Папка проектов: ${PROJECTS_DIR}\n\n` +
      "Кнопки внизу:\n" +
      `${BTN_PROJECT} — выбрать или создать проект (у каждого проекта свой диалог)\n` +
      `${BTN_CHAT} — обычный чат без проекта\n` +
      `${BTN_LIMITS} — использование лимитов подписки\n` +
      `${BTN_SETTINGS} — авто-режим и выбор модели\n\n` +
      "Когда Клод задаёт вопрос с вариантами — отвечайте кнопками под сообщением.\n\n" +
      "Команды:\n" +
      "/new — сбросить диалог текущего проекта/чата\n" +
      "/stop — прервать текущую задачу\n" +
      "/status — что сейчас происходит",
    { reply_markup: mainKeyboard }
  );
});

bot.command("new", async (ctx) => {
  const cs = getChatState(ctx.chat.id);
  delete cs.sessions[sessionKey(cs)];
  saveState();
  await ctx.reply(`Диалог сброшен (${modeLabel(cs)}). Следующее сообщение начнёт новый.`);
});

bot.command("stop", async (ctx) => {
  const runState = running.get(ctx.chat.id);
  if (!runState) {
    await ctx.reply("Сейчас ничего не выполняется.");
    return;
  }
  runState.abortController.abort();
  await ctx.reply("Останавливаю текущую задачу…");
});

bot.command("status", async (ctx) => {
  const cs = getChatState(ctx.chat.id);
  const busy = running.has(ctx.chat.id);
  const hasSession = Boolean(cs.sessions[sessionKey(cs)]);
  await ctx.reply(
    `Режим: ${modeLabel(cs)}\n` +
      (busy ? "Выполняется задача." : "Свободен.") +
      (hasSession ? " Диалог продолжается (сбросить: /new)." : " Активного диалога нет.")
  );
});

// ---------- Инлайн-кнопки (подтверждения и выбор проекта) ----------

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Подтверждение команды
  const appr = /^appr:(\d+):(yes|no)$/.exec(data);
  if (appr) {
    const [, id, decision] = appr;
    const pending = pendingApprovals.get(id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Этот запрос уже неактуален." });
      return;
    }
    pendingApprovals.delete(id);
    pending.resolve(decision === "yes");
    await ctx.answerCallbackQuery({ text: decision === "yes" ? "Разрешено" : "Отклонено" });
    try {
      await ctx.editMessageReplyMarkup(undefined);
      await ctx.reply(decision === "yes" ? "✅ Команда разрешена." : "❌ Команда отклонена.");
    } catch {
      // не критично
    }
    return;
  }

  const chatId = ctx.chatId;
  if (chatId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }

  // Ответ на вопрос Клода (один вариант)
  const qopt = /^qopt:(\d+):(\d+)$/.exec(data);
  if (qopt) {
    const pq = pendingQuestions.get(qopt[1]);
    if (!pq) {
      await ctx.answerCallbackQuery({ text: "Этот вопрос уже неактуален." });
      return;
    }
    const i = Number(qopt[2]);
    if (pq.multi) {
      if (pq.selected.has(i)) pq.selected.delete(i);
      else pq.selected.add(i);
      const chosen = [...pq.selected].map((x) => pq.options[x]).join(", ");
      await ctx.answerCallbackQuery({ text: `Выбрано: ${chosen || "ничего"}` });
    } else {
      await ctx.answerCallbackQuery();
      await ctx.reply(`➡️ ${pq.options[i]}`);
      pq.resolve(pq.options[i]);
    }
    return;
  }

  // Ответ на вопрос Клода (мультивыбор, «Готово»)
  const qdone = /^qdone:(\d+)$/.exec(data);
  if (qdone) {
    const pq = pendingQuestions.get(qdone[1]);
    if (!pq) {
      await ctx.answerCallbackQuery({ text: "Этот вопрос уже неактуален." });
      return;
    }
    const labels = [...pq.selected].sort((a, b) => a - b).map((i) => pq.options[i]);
    if (labels.length === 0) {
      await ctx.answerCallbackQuery({ text: "Выберите хотя бы один вариант." });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(`➡️ ${labels.join(", ")}`);
    pq.resolve(labels.join(", "));
    return;
  }

  // Ответ цифрой на нумерованный список в обычном ответе
  const num = /^numreply:(\d+)$/.exec(data);
  if (num) {
    if (running.has(chatId)) {
      await ctx.answerCallbackQuery({ text: "Дождитесь конца текущей задачи." });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // не критично
    }
    await ctx.reply(`➡️ ${num[1]}`);
    void runClaudeTurn(ctx, chatId, num[1]);
    return;
  }

  // Настройки: авто-режим и модель
  if (data === "set:auto" || data.startsWith("set:model:")) {
    const cs = getChatState(chatId);
    if (data === "set:auto") {
      cs.auto = !cs.auto;
    } else {
      const value = data.slice("set:model:".length);
      cs.model = value === "default" ? undefined : value;
    }
    saveState();
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(settingsText(cs), { reply_markup: settingsKeyboard(cs) });
    } catch {
      // текст не изменился — не критично
    }
    return;
  }

  // Выбор проекта
  const proj = /^proj:(\d+)$/.exec(data);
  if (proj) {
    if (running.has(chatId)) {
      await ctx.answerCallbackQuery({ text: "Дождитесь конца задачи или /stop." });
      return;
    }
    const list = lastProjectList.get(chatId) || [];
    const entry = list[Number(proj[1])];
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Проект не найден, откройте список заново." });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // не критично
    }

    let projectDir = entry.dir;
    if (projectDir && !fs.existsSync(projectDir)) {
      await ctx.reply(`Папка проекта не найдена: ${projectDir}`);
      return;
    }
    if (!projectDir) {
      // Репозитория нет на диске — клонируем с GitHub
      const target = path.join(PROJECTS_DIR, entry.name);
      const cloneMsg = await ctx.reply(`⏳ Клонирую ${GITHUB_USER}/${entry.name} с GitHub…`);
      try {
        await execFileAsync(
          "git",
          ["clone", `https://github.com/${GITHUB_USER}/${entry.name}.git`, target],
          { timeout: 5 * 60 * 1000 }
        );
        projectDir = target;
      } catch (err) {
        console.error("Ошибка клонирования:", err);
        await ctx.reply(
          `Не удалось склонировать ${entry.name}: ` +
            (err instanceof Error ? err.message : String(err))
        );
        return;
      } finally {
        try {
          await ctx.api.deleteMessage(chatId, cloneMsg.message_id);
        } catch {
          // не критично
        }
      }
    }

    const cs = getChatState(chatId);
    cs.mode = "project";
    cs.project = entry.name;
    cs.projectDir = projectDir;
    saveState();

    // Показываем прошлые диалоги по этой папке (включая сессии из Cursor)
    const past = listPastSessions(projectDir);
    if (past.length === 0) {
      delete cs.sessions[sessionKey(cs)];
      saveState();
      await ctx.reply(
        `Выбран проект «${entry.name}»${entry.dir ? "" : " (склонирован)"}.\nПапка: ${projectDir}\nПрошлых диалогов нет — пишите задачу.`
      );
      return;
    }
    lastSessionList.set(chatId, past);
    const kb = new InlineKeyboard().text("🆕 Новый диалог", "sess:new").row();
    past.forEach((s, i) => {
      kb.text(sessionButtonLabel(s), `sess:${i}`).row();
    });
    await ctx.reply(
      `Выбран проект «${entry.name}»${entry.dir ? "" : " (склонирован)"}.\nПапка: ${projectDir}\n\nПродолжить прошлый диалог или начать новый?`,
      { reply_markup: kb }
    );
    return;
  }

  // Выбор прошлого диалога (или нового) после выбора проекта
  const sess = /^sess:(new|\d+)$/.exec(data);
  if (sess) {
    if (running.has(chatId)) {
      await ctx.answerCallbackQuery({ text: "Дождитесь конца задачи или /stop." });
      return;
    }
    const cs = getChatState(chatId);
    const key = sessionKey(cs);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // не критично
    }
    if (sess[1] === "new") {
      delete cs.sessions[key];
      saveState();
      await ctx.reply("🆕 Начат новый диалог — пишите задачу.");
      return;
    }
    const list = lastSessionList.get(chatId) || [];
    const chosen = list[Number(sess[1])];
    if (!chosen) {
      await ctx.reply("Этот список устарел — выберите проект заново.");
      return;
    }
    cs.sessions[key] = chosen.id;
    saveState();
    await ctx.reply(
      `Продолжаем диалог «${chosen.title.slice(0, 80)}». Пишите сообщение.`
    );
    return;
  }

  // Создание нового проекта
  if (data === "projnew") {
    awaitingProjectName.add(chatId);
    await ctx.answerCallbackQuery();
    await ctx.reply("Напишите название нового проекта (это будет имя папки):");
    return;
  }

  await ctx.answerCallbackQuery();
});

// ---------- Кнопки главного меню ----------

async function handleProjectButton(ctx: Context, chatId: number): Promise<void> {
  const cs = getChatState(chatId);
  let projects: ProjectEntry[];
  try {
    projects = await listProjects();
  } catch (err) {
    console.error("Ошибка получения списка репозиториев:", err);
    await ctx.reply(
      "Не удалось получить список репозиториев с GitHub: " +
        (err instanceof Error ? err.message : String(err))
    );
    return;
  }
  lastProjectList.set(chatId, projects);
  const kb = new InlineKeyboard();
  projects.forEach((p, i) => {
    kb.text(`${p.dir ? "💻" : "☁️"} ${p.name}`, `proj:${i}`).row();
  });
  kb.text("➕ Новый проект", "projnew");
  await ctx.reply(
    `Сейчас выбран: ${modeLabel(cs)}\n` +
      `Репозитории ${GITHUB_USER} (💻 — уже на диске, ☁️ — склонируется при выборе):`,
    { reply_markup: kb }
  );
}

async function handleChatButton(ctx: Context, chatId: number): Promise<void> {
  if (running.has(chatId)) {
    await ctx.reply("Дождитесь конца текущей задачи или отправьте /stop.");
    return;
  }
  const cs = getChatState(chatId);
  cs.mode = "chat";
  saveState();
  const hasSession = Boolean(cs.sessions[sessionKey(cs)]);
  await ctx.reply(
    "Режим: обычный чат без проекта.\n" +
      (hasSession ? "Продолжаем прошлый диалог чата (сбросить: /new)." : "Пишите вопрос.")
  );
}

// ---------- Основной обработчик сообщений ----------

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  // Если Клод ждёт ответа на вопрос — обычный текст считается ответом
  const activeQid = activeQuestionByChat.get(chatId);
  if (activeQid) {
    const pq = pendingQuestions.get(activeQid);
    if (pq) {
      pq.resolve(text);
      return;
    }
  }

  // Ожидаем название нового проекта
  if (awaitingProjectName.has(chatId) && !MENU_BUTTONS.includes(text)) {
    awaitingProjectName.delete(chatId);
    const name = sanitizeProjectName(text);
    if (!name) {
      await ctx.reply("Название пустое — попробуйте ещё раз через кнопку «📁 Проект».");
      return;
    }
    const dir = path.join(PROJECTS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    const cs = getChatState(chatId);
    cs.mode = "project";
    cs.project = name;
    cs.projectDir = dir;
    saveState();
    await ctx.reply(`Проект «${name}» создан и выбран.\nПапка: ${dir}\nПишите задачу.`);
    return;
  }

  // Кнопки меню
  if (text === BTN_LIMITS) {
    void handleLimits(ctx); // не блокируем приём следующих сообщений
    return;
  }
  if (text === BTN_PROJECT) {
    await handleProjectButton(ctx, chatId);
    return;
  }
  if (text === BTN_CHAT) {
    await handleChatButton(ctx, chatId);
    return;
  }
  if (text === BTN_SETTINGS) {
    const cs = getChatState(chatId);
    await ctx.reply(settingsText(cs), { reply_markup: settingsKeyboard(cs) });
    return;
  }

  if (running.has(chatId)) {
    await ctx.reply("Я ещё выполняю предыдущую задачу. Подождите или отправьте /stop.");
    return;
  }

  // Не ждём завершения: иначе бот не сможет принимать новые сообщения
  // (нажатия кнопок, /stop) пока идёт задача. Ошибки ловятся внутри.
  void runClaudeTurn(ctx, chatId, text);
});

// ---------- Приём файлов из Telegram ----------

function sanitizeFileName(raw: string): string {
  const name = path.basename(raw).replace(/[\\/:*?"<>|]/g, "_").trim();
  return name || `file_${Date.now()}`;
}

// Скачивает файл Telegram в папку _incoming текущего проекта/чата
async function saveTelegramFile(
  ctx: Context,
  fileId: string,
  suggestedName: string,
  cwd: string
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram не вернул путь файла");
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Скачивание не удалось: ${res.status}`);
  const dir = path.join(cwd, "_incoming");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, sanitizeFileName(suggestedName || file.file_path));
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function handleIncomingFile(
  ctx: Context,
  fileId: string,
  suggestedName: string,
  fileSize: number | undefined,
  caption: string | undefined
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (running.has(chatId)) {
    await ctx.reply("Я ещё выполняю предыдущую задачу — пришлите файл после её завершения или /stop.");
    return;
  }
  // Ограничение Telegram Bot API на скачивание — 20 МБ
  if (fileSize && fileSize > 20 * 1024 * 1024) {
    await ctx.reply("Файл больше 20 МБ — Telegram не даёт ботам скачивать такие. Положите его в папку проекта вручную.");
    return;
  }
  const cs = getChatState(chatId);
  const cwd = cwdFor(cs);
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const dest = await saveTelegramFile(ctx, fileId, suggestedName, cwd);
    await ctx.reply(`📎 Файл сохранён: ${dest}`);
    const prompt =
      `Я прислал файл, он сохранён по пути: ${dest}\n` +
      (caption?.trim() ? caption.trim() : "Посмотри его.");
    void runClaudeTurn(ctx, chatId, prompt);
  } catch (err) {
    console.error("Ошибка приёма файла:", err);
    await ctx.reply(
      "Не удалось скачать файл: " + (err instanceof Error ? err.message : String(err))
    );
  }
}

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  await handleIncomingFile(
    ctx,
    doc.file_id,
    doc.file_name ?? `document_${Date.now()}`,
    doc.file_size,
    ctx.message.caption
  );
});

bot.on("message:photo", async (ctx) => {
  // Берём самый большой размер фото
  const sizes = ctx.message.photo;
  const best = sizes[sizes.length - 1];
  await handleIncomingFile(
    ctx,
    best.file_id,
    `photo_${ctx.message.message_id}.jpg`,
    best.file_size,
    ctx.message.caption
  );
});

// Запуск одного «хода» Клода: отправляет text в сессию текущего проекта/чата
async function runClaudeTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  const cs = getChatState(chatId);
  const key = sessionKey(cs);
  const cwd = cwdFor(cs);
  fs.mkdirSync(cwd, { recursive: true });

  const abortController = new AbortController();
  const runState: RunState = { abortController, lastStatusEdit: 0 };
  running.set(chatId, runState);

  // canUseTool вызывается для инструментов, не разрешённых автоматически
  // (прежде всего Bash) — спрашиваем подтверждение в Telegram.
  const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    // Вопрос Клода с вариантами — показываем кнопки и возвращаем выбор
    if (toolName === "AskUserQuestion") {
      const questions = (input as { questions?: AskQuestion[] }).questions;
      if (Array.isArray(questions) && questions.length > 0) {
        const answers: Record<string, string> = {};
        for (const qu of questions) {
          const answer = await askQuestionViaTelegram(ctx, chatId, qu, signal);
          if (answer === null) {
            return { behavior: "deny", message: "Пользователь не ответил на вопрос" };
          }
          answers[qu.question] = answer;
        }
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }
    }

    // Авто-режим: всё остальное одобряется без подтверждений
    if (cs.auto) {
      return { behavior: "allow", updatedInput: input };
    }

    const id = String(++approvalCounter);
    const keyboard = new InlineKeyboard()
      .text("✅ Разрешить", `appr:${id}:yes`)
      .text("❌ Отклонить", `appr:${id}:no`);

    await ctx.reply(`Клод хочет выполнить:\n\n${describeToolUse(toolName, input)}`, {
      reply_markup: keyboard,
    });

    const allowed = await new Promise<boolean>((resolve) => {
      pendingApprovals.set(id, { resolve });
      const timeout = setTimeout(() => {
        if (pendingApprovals.delete(id)) resolve(false);
      }, 10 * 60 * 1000); // 10 минут на ответ, иначе отказ
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        if (pendingApprovals.delete(id)) resolve(false);
      });
    });

    const result: PermissionResult = allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Пользователь отклонил действие в Telegram" };
    return result;
  };

  const updateStatus = async (statusText: string) => {
    const now = Date.now();
    if (now - runState.lastStatusEdit < 1500) return; // не чаще раза в 1.5 с
    runState.lastStatusEdit = now;
    try {
      if (runState.statusMessageId) {
        await ctx.api.editMessageText(chatId, runState.statusMessageId, statusText);
      } else {
        const msg = await ctx.reply(statusText);
        runState.statusMessageId = msg.message_id;
      }
    } catch {
      // лимиты Telegram на редактирование — просто пропускаем
    }
  };

  try {
    await updateStatus("⏳ Думаю…");

    let finalText = "";
    let resultError: string | undefined;

    for await (const message of query({
      prompt: text,
      options: {
        cwd,
        resume: cs.sessions[key],
        model: cs.model,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "Твой ответ будет показан в Telegram: пиши кратко, обычным текстом, без markdown-таблиц. " +
            "Если нужно спросить пользователя и предложить варианты ответа — вызывай инструмент AskUserQuestion.",
        },
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task"],
        canUseTool,
        abortController,
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        cs.sessions[key] = message.session_id;
        saveState();
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            await updateStatus(`🔧 ${describeToolUse(block.name, block.input as Record<string, unknown>)}`);
          }
        }
      } else if (message.type === "result") {
        cs.sessions[key] = message.session_id;
        saveState();
        if (message.subtype === "success") {
          finalText = message.result;
        } else {
          resultError = message.subtype;
        }
      }
    }

    // убираем статусное сообщение
    if (runState.statusMessageId) {
      try {
        await ctx.api.deleteMessage(chatId, runState.statusMessageId);
      } catch {
        // не критично
      }
    }

    if (finalText) {
      await sendLong(ctx, finalText);
      // Если в ответе нумерованный список — предлагаем ответить кнопкой
      const numOptions = detectNumberedOptions(finalText);
      if (numOptions.length > 0) {
        const kb = new InlineKeyboard();
        numOptions.forEach((n) => kb.text(String(n), `numreply:${n}`));
        await ctx.reply("Можно ответить кнопкой:", { reply_markup: kb });
      }
    } else if (resultError) {
      await ctx.reply(`Задача завершилась с ошибкой: ${resultError}`);
    } else if (abortController.signal.aborted) {
      await ctx.reply("Задача остановлена.");
    } else {
      await ctx.reply("Клод завершил работу без текстового ответа.");
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      await ctx.reply("Задача остановлена.");
    } else {
      console.error("Ошибка выполнения запроса:", err);
      await ctx.reply(`Произошла ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    running.delete(chatId);
  }
}

bot.catch((err) => {
  console.error("Ошибка бота:", err.error);
});

console.log(`Запускаю бота. Папка проектов: ${PROJECTS_DIR}`);
bot.start({
  onStart: (me) => console.log(`Бот @${me.username} запущен. Пишите ему в Telegram.`),
});
