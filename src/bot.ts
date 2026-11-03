import { Bot, InlineKeyboard } from "grammy";
import {
  BOT_TOKEN,
  GUEST_PROJECT,
  SETUP_MODE,
  WEBAPP_URL,
  isGuestUser,
  isOwnerUser,
} from "./config.js";
import { ensureGuestState } from "./state.js";
import { startWebApp } from "./webapp.js";

if (!BOT_TOKEN) {
  console.error(
    "Ошибка: TELEGRAM_BOT_TOKEN не задан. Скопируйте .env.example в .env и заполните."
  );
  process.exit(1);
}

if (SETUP_MODE) {
  console.warn(
    "ALLOWED_USER_IDS пуст — запускаюсь в режиме настройки: отвечаю любому его же ID, доступа к Клоду нет."
  );
}

const HTTPS_WEBAPP = WEBAPP_URL.startsWith("https://");
if (WEBAPP_URL && !HTTPS_WEBAPP) {
  console.warn(
    `WEBAPP_URL (${WEBAPP_URL}) не https:// — Telegram не откроет мини-приложение по такому адресу.`
  );
}

// ---------- Бот-лаунчер ----------
// Вся работа с Клодом идёт в мини-приложении; бот только открывает его.

const bot = new Bot(BOT_TOKEN);

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
  const owner = isOwnerUser(ctx.from);
  const guest = !owner && isGuestUser(ctx.from);
  if (!ctx.from || (!owner && !guest)) {
    console.warn(`Отклонён запрос от чужого пользователя: ${ctx.from?.id}`);
    return;
  }
  if (guest) {
    ensureGuestState(ctx.from.id);
    console.log(
      `[guest] ${ctx.from.id} (@${ctx.from.username ?? "без username"})` +
        " — гостевой доступ к мини-приложению"
    );
  }
  await next();
});

async function replyWithAppButton(ctx: {
  reply: (text: string, other?: object) => Promise<unknown>;
  from?: { id: number; username?: string };
}): Promise<void> {
  const guest = isGuestUser(ctx.from);
  if (!HTTPS_WEBAPP) {
    await ctx.reply(
      "Мини-приложение ещё не опубликовано: задайте WEBAPP_URL (https-адрес) в .env и перезапустите бота.\n\n" +
        "Проще всего — туннель, например:\n" +
        "cloudflared tunnel --url http://localhost:3000"
    );
    return;
  }
  const kb = new InlineKeyboard().webApp("🚀 Открыть Claude", WEBAPP_URL);
  await ctx.reply(
    guest
      ? `Вам доступен проект «${GUEST_PROJECT}». Работа с Клодом — в мини-приложении:`
      : "Работа с Клодом — в мини-приложении (кнопка ниже или кнопка меню слева от поля ввода):",
    { reply_markup: kb }
  );
}

bot.command("start", replyWithAppButton);
bot.on("message", replyWithAppButton);

bot.catch((err) => {
  console.error("Ошибка бота:", err.error);
});

// ---------- Запуск ----------

startWebApp();

if (HTTPS_WEBAPP) {
  // Кнопка меню (слева от поля ввода) открывает мини-приложение.
  // Ставится при каждом старте — BotFather не нужен.
  bot.api
    .setChatMenuButton({
      menu_button: { type: "web_app", text: "Claude", web_app: { url: WEBAPP_URL } },
    })
    .then(() => console.log(`Кнопка меню ведёт на ${WEBAPP_URL}`))
    .catch((err) => console.warn("Не удалось установить кнопку меню:", err));
}

bot.start({
  onStart: (me) =>
    console.log(
      `Бот @${me.username} запущен.` +
        (HTTPS_WEBAPP
          ? " Мини-приложение подключено."
          : " ВНИМАНИЕ: WEBAPP_URL не задан — мини-приложение не открыть из Telegram.")
    ),
});
