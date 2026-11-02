import "dotenv/config";
import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import {
  query,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

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
  return cs.mode === "project" && cs.project
    ? path.join(PROJECTS_DIR, cs.project)
    : CHAT_DIR;
}

function modeLabel(cs: ChatState): string {
  return cs.mode === "project" && cs.project
    ? `проект «${cs.project}»`
    : "обычный чат (без проекта)";
}

// ---------- Проекты ----------

type ProjectEntry = { name: string; git: boolean };

function listProjects(): ProjectEntry[] {
  try {
    return fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        git: fs.existsSync(path.join(PROJECTS_DIR, e.name, ".git")),
      }))
      // git-репозитории сверху, внутри групп — по алфавиту
      .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name, "ru"));
  } catch {
    return [];
  }
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

// chatId -> список проектов, показанный последней инлайн-клавиатурой
const lastProjectList = new Map<number, string[]>();
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

// ---------- Кнопки ----------

const BTN_LIMITS = "📊 Лимиты";
const BTN_PROJECT = "📁 Проект";
const BTN_CHAT = "💬 Чат";

const mainKeyboard = new Keyboard()
  .text(BTN_LIMITS)
  .text(BTN_PROJECT)
  .text(BTN_CHAT)
  .resized()
  .persistent();

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
  await next();
});

bot.command("start", async (ctx) => {
  const cs = getChatState(ctx.chat.id);
  await ctx.reply(
    "Привет! Я мост между Telegram и Claude (Agent SDK).\n\n" +
      `Сейчас выбран: ${modeLabel(cs)}\n` +
      `Папка проектов: ${PROJECTS_DIR}\n\n` +
      "Кнопки внизу:\n" +
      `${BTN_LIMITS} — использование лимитов подписки\n` +
      `${BTN_PROJECT} — выбрать или создать проект (у каждого проекта свой диалог)\n` +
      `${BTN_CHAT} — обычный чат без проекта\n\n` +
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

  // Выбор проекта
  const proj = /^proj:(\d+)$/.exec(data);
  if (proj) {
    if (running.has(chatId)) {
      await ctx.answerCallbackQuery({ text: "Дождитесь конца задачи или /stop." });
      return;
    }
    const list = lastProjectList.get(chatId) || [];
    const name = list[Number(proj[1])];
    if (!name || !fs.existsSync(path.join(PROJECTS_DIR, name))) {
      await ctx.answerCallbackQuery({ text: "Проект не найден, откройте список заново." });
      return;
    }
    const cs = getChatState(chatId);
    cs.mode = "project";
    cs.project = name;
    saveState();
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // не критично
    }
    const hasSession = Boolean(cs.sessions[sessionKey(cs)]);
    await ctx.reply(
      `Выбран проект «${name}».\n` +
        (hasSession ? "Продолжаем прошлый диалог этого проекта (сбросить: /new)." : "Диалог проекта пока пуст — пишите задачу.")
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
  const projects = listProjects();
  lastProjectList.set(chatId, projects.map((p) => p.name));
  const kb = new InlineKeyboard();
  projects.forEach((p, i) => {
    kb.text(`${p.git ? "🟢" : "📂"} ${p.name}`, `proj:${i}`).row();
  });
  kb.text("➕ Новый проект", "projnew");
  await ctx.reply(
    `Сейчас выбран: ${modeLabel(cs)}\n` +
      (projects.length > 0 ? "Выберите проект:" : "Проектов пока нет — создайте первый:"),
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

  // Ожидаем название нового проекта
  if (awaitingProjectName.has(chatId) && ![BTN_LIMITS, BTN_PROJECT, BTN_CHAT].includes(text)) {
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
    saveState();
    await ctx.reply(`Проект «${name}» создан и выбран.\nПапка: ${dir}\nПишите задачу.`);
    return;
  }

  // Кнопки меню
  if (text === BTN_LIMITS) {
    await handleLimits(ctx);
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

  if (running.has(chatId)) {
    await ctx.reply("Я ещё выполняю предыдущую задачу. Подождите или отправьте /stop.");
    return;
  }

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
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "Твой ответ будет показан в Telegram: пиши кратко, обычным текстом, без markdown-таблиц.",
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
});

bot.catch((err) => {
  console.error("Ошибка бота:", err.error);
});

console.log(`Запускаю бота. Папка проектов: ${PROJECTS_DIR}`);
bot.start({
  onStart: (me) => console.log(`Бот @${me.username} запущен. Пишите ему в Telegram.`),
});
