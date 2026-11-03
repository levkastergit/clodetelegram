import "dotenv/config";
import * as path from "node:path";

// ---------- Конфигурация ----------

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

// Список разрешённых Telegram ID через запятую (ALLOWED_USER_IDS=111,222).
// Старое имя ALLOWED_USER_ID с одним ID тоже работает.
export const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USER_ID || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
);

// Корневая папка с папками проектов (например, рабочий стол с git-репозиториями)
export const PROJECTS_DIR =
  process.env.PROJECTS_DIR ||
  process.env.WORKING_DIR ||
  path.join(process.cwd(), "workspace");

// Папка обычного чата — отдельно, чтобы не засорять папку проектов
export const CHAT_DIR =
  process.env.CHAT_DIR || path.join(process.cwd(), "workspace", "_chat");

// Аккаунт GitHub: список проектов = репозитории этого аккаунта
export const GITHUB_USER = process.env.GITHUB_USER || "levkastergit";

// Дополнительные проекты — абсолютные пути через точку с запятой
export const EXTRA_PROJECTS = (process.env.EXTRA_PROJECTS || "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

// Мини-приложение Telegram: адрес, по которому оно доступно снаружи (HTTPS),
// и порт локального сервера.
export const WEBAPP_URL = (process.env.WEBAPP_URL || "").replace(/\/+$/, "");
export const PORT = Number(process.env.PORT || 3000);

// ---------- Гостевой доступ (второй аккаунт с ограничениями) ----------
// Гость видит только один проект (GUEST_PROJECT) и только свои диалоги.
// Личная информация владельца (другие проекты, файлы вне папки проекта,
// лимиты подписки) гостю недоступна.

export const GUEST_USER_IDS = new Set(
  (process.env.GUEST_USER_IDS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
);

export const GUEST_USERNAMES = new Set(
  (process.env.GUEST_USERNAMES || "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean)
);

export const GUEST_PROJECT = process.env.GUEST_PROJECT || "playerok";
export const GUEST_PROJECT_DIR =
  process.env.GUEST_PROJECT_DIR || path.join(PROJECTS_DIR, GUEST_PROJECT);

export type TgUser = { id: number; username?: string };

export function isOwnerUser(from?: TgUser): boolean {
  return Boolean(from && ALLOWED_USER_IDS.has(from.id));
}

export function isGuestUser(from?: TgUser): boolean {
  if (!from) return false;
  if (ALLOWED_USER_IDS.has(from.id)) return false; // владелец — не гость
  if (GUEST_USER_IDS.has(from.id)) return true;
  const u = from.username?.toLowerCase();
  return Boolean(u && GUEST_USERNAMES.has(u));
}

// Режим настройки: ID не заданы — бот не даёт доступа к Клоду,
// а только сообщает написавшему его Telegram ID для заполнения .env.
export const SETUP_MODE = ALLOWED_USER_IDS.size === 0;

// Пользователь выбрал работу через подписку Claude (Pro/Max).
// Если в окружении есть ANTHROPIC_API_KEY, он имел бы приоритет над подпиской —
// убираем его, чтобы случайно не тратить деньги через API.
if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "ANTHROPIC_API_KEY найден в окружении — игнорирую его, используется подписка Claude."
  );
  delete process.env.ANTHROPIC_API_KEY;
}
