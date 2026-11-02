import "dotenv/config";
import { Bot, Context, InlineKeyboard } from "grammy";
import {
  query,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------- Конфигурация ----------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = Number(process.env.ALLOWED_USER_ID);
const WORKING_DIR =
  process.env.WORKING_DIR || path.join(process.cwd(), "workspace");

if (!BOT_TOKEN) {
  console.error("Ошибка: TELEGRAM_BOT_TOKEN не задан. Скопируйте .env.example в .env и заполните.");
  process.exit(1);
}
if (!Number.isInteger(ALLOWED_USER_ID) || ALLOWED_USER_ID <= 0) {
  console.error("Ошибка: ALLOWED_USER_ID не задан или некорректен (нужен числовой Telegram ID).");
  process.exit(1);
}

// Пользователь выбрал работу через подписку Claude (Pro/Max).
// Если в окружении есть ANTHROPIC_API_KEY, он имел бы приоритет над подпиской —
// убираем его, чтобы случайно не тратить деньги через API.
if (process.env.ANTHROPIC_API_KEY) {
  console.warn("ANTHROPIC_API_KEY найден в окружении — игнорирую его, используется подписка Claude.");
  delete process.env.ANTHROPIC_API_KEY;
}

fs.mkdirSync(WORKING_DIR, { recursive: true });

// ---------- Хранилище сессий (chatId -> sessionId) ----------

const SESSIONS_FILE = path.join(process.cwd(), "sessions.json");

function loadSessions(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSessions(sessions: Record<string, string>): void {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

const sessions = loadSessions();

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

// ---------- Бот ----------

const bot = new Bot(BOT_TOKEN);

// Доступ только владельцу
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) {
    console.warn(`Отклонён запрос от чужого пользователя: ${ctx.from?.id}`);
    return;
  }
  await next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я мост между Telegram и Claude (Agent SDK).\n\n" +
      `Рабочая папка агента: ${WORKING_DIR}\n\n` +
      "Просто напишите задачу — Клод выполнит её и ответит сюда.\n\n" +
      "Команды:\n" +
      "/new — начать новый диалог (сбросить контекст)\n" +
      "/stop — прервать текущую задачу\n" +
      "/status — что сейчас происходит"
  );
});

bot.command("new", async (ctx) => {
  const chatId = String(ctx.chat.id);
  delete sessions[chatId];
  saveSessions(sessions);
  await ctx.reply("Контекст сброшен — следующее сообщение начнёт новый диалог.");
});

bot.command("stop", async (ctx) => {
  const state = running.get(ctx.chat.id);
  if (!state) {
    await ctx.reply("Сейчас ничего не выполняется.");
    return;
  }
  state.abortController.abort();
  await ctx.reply("Останавливаю текущую задачу…");
});

bot.command("status", async (ctx) => {
  const busy = running.has(ctx.chat.id);
  const hasSession = Boolean(sessions[String(ctx.chat.id)]);
  await ctx.reply(
    (busy ? "Выполняется задача." : "Свободен.") +
      (hasSession ? " Диалог продолжается (сбросить: /new)." : " Активного диалога нет.")
  );
});

// Кнопки подтверждения команд
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const match = /^appr:(\d+):(yes|no)$/.exec(data);
  if (!match) {
    await ctx.answerCallbackQuery();
    return;
  }
  const [, id, decision] = match;
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
});

// Основной обработчик сообщений
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  if (running.has(chatId)) {
    await ctx.reply("Я ещё выполняю предыдущую задачу. Подождите или отправьте /stop.");
    return;
  }

  const abortController = new AbortController();
  const state: RunState = { abortController, lastStatusEdit: 0 };
  running.set(chatId, state);

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

  const updateStatus = async (text: string) => {
    const now = Date.now();
    if (now - state.lastStatusEdit < 1500) return; // не чаще раза в 1.5 с
    state.lastStatusEdit = now;
    try {
      if (state.statusMessageId) {
        await ctx.api.editMessageText(chatId, state.statusMessageId, text);
      } else {
        const msg = await ctx.reply(text);
        state.statusMessageId = msg.message_id;
      }
    } catch {
      // лимиты Telegram на редактирование — просто пропускаем
    }
  };

  try {
    await updateStatus("⏳ Думаю…");

    const chatKey = String(chatId);
    let finalText = "";
    let resultError: string | undefined;

    for await (const message of query({
      prompt: ctx.message.text,
      options: {
        cwd: WORKING_DIR,
        resume: sessions[chatKey],
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
        sessions[chatKey] = message.session_id;
        saveSessions(sessions);
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            await updateStatus(`🔧 ${describeToolUse(block.name, block.input as Record<string, unknown>)}`);
          }
        }
      } else if (message.type === "result") {
        sessions[chatKey] = message.session_id;
        saveSessions(sessions);
        if (message.subtype === "success") {
          finalText = message.result;
        } else {
          resultError = message.subtype;
        }
      }
    }

    // убираем статусное сообщение
    if (state.statusMessageId) {
      try {
        await ctx.api.deleteMessage(chatId, state.statusMessageId);
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

console.log(`Запускаю бота. Рабочая папка агента: ${WORKING_DIR}`);
bot.start({
  onStart: (me) => console.log(`Бот @${me.username} запущен. Пишите ему в Telegram.`),
});
