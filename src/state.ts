import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CHAT_DIR,
  EXTRA_PROJECTS,
  GITHUB_USER,
  GUEST_PROJECT,
  GUEST_PROJECT_DIR,
  PROJECTS_DIR,
} from "./config.js";

// ---------- Состояние пользователей (режим, проект, сессии) ----------
// Ключ — Telegram user id (для личных чатов совпадает со старым chat id,
// поэтому state.json от бота продолжает работать).

export type UserState = {
  mode: "chat" | "project";
  project?: string;
  // Абсолютный путь папки проекта; для старых записей отсутствует —
  // тогда берётся PROJECTS_DIR/<project>
  projectDir?: string;
  // Авто-режим: все действия Клода одобряются без подтверждений
  auto?: boolean;
  // Модель: "opus" | "sonnet" | "haiku"; не задано — модель по умолчанию
  model?: string;
  // Гостевой пользователь: доступ ограничен одним проектом и своими диалогами
  guest?: boolean;
  // Сессии, созданные этим пользователем, — гостю показываются только они
  ownedSessions?: string[];
  // ключ: "chat" или "project:<имя>" -> session_id Клода
  sessions: Record<string, string>;
};

const STATE_FILE = path.join(process.cwd(), "state.json");

function loadState(): Record<string, UserState> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

const state = loadState();

export function saveState(): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getUserState(userId: number): UserState {
  const key = String(userId);
  if (!state[key]) {
    state[key] = { mode: "chat", sessions: {} };
  }
  return state[key];
}

// Гость всегда закреплён за одним проектом — чат и другие проекты недоступны
export function ensureGuestState(userId: number): UserState {
  const cs = getUserState(userId);
  if (
    !cs.guest ||
    cs.mode !== "project" ||
    cs.project !== GUEST_PROJECT ||
    cs.projectDir !== GUEST_PROJECT_DIR
  ) {
    cs.guest = true;
    cs.mode = "project";
    cs.project = GUEST_PROJECT;
    cs.projectDir = GUEST_PROJECT_DIR;
    saveState();
  }
  return cs;
}

export function sessionKey(cs: UserState): string {
  return cs.mode === "project" && cs.project ? `project:${cs.project}` : "chat";
}

export function cwdFor(cs: UserState): string {
  if (cs.mode === "project" && cs.project) {
    return cs.projectDir || path.join(PROJECTS_DIR, cs.project);
  }
  return CHAT_DIR;
}

export function modeLabel(cs: UserState): string {
  return cs.mode === "project" && cs.project
    ? `проект «${cs.project}»`
    : "обычный чат (без проекта)";
}

// Запоминает, что сессия создана этим пользователем (для фильтра диалогов гостя)
export function recordOwnedSession(cs: UserState, sessionId: string): void {
  if (!cs.ownedSessions) cs.ownedSessions = [];
  if (!cs.ownedSessions.includes(sessionId)) {
    cs.ownedSessions.push(sessionId);
    // не даём списку расти бесконечно
    if (cs.ownedSessions.length > 500) {
      cs.ownedSessions.splice(0, cs.ownedSessions.length - 500);
    }
  }
}

// ---------- Проекты ----------

// Проект = репозиторий аккаунта GitHub или дополнительный локальный путь.
// dir — абсолютный путь папки на диске, если она уже есть.
export type ProjectEntry = { name: string; dir?: string };

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

export async function listProjects(): Promise<ProjectEntry[]> {
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

export function sanitizeProjectName(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 60);
}

export function sanitizeFileName(raw: string): string {
  const name = path.basename(raw).replace(/[\\/:*?"<>|]/g, "_").trim();
  return name || `file_${Date.now()}`;
}

// ---------- Прошлые сессии Claude Code по папке проекта ----------
// Claude Code (и SDK, и Cursor) хранит диалоги в ~/.claude/projects/<папка>,
// где имя папки — путь проекта с заменой всех спецсимволов на дефисы.

export type SessionInfo = { id: string; mtime: Date; title: string };

function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

// Папка ~/.claude/projects/<встреченное-имя> для данной папки проекта
function claudeProjectFolder(projectDir: string): string | undefined {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const encoded = encodeProjectDir(projectDir).toLowerCase();
  try {
    const dirName = fs
      .readdirSync(projectsRoot)
      .find((d) => d.toLowerCase() === encoded);
    return dirName ? path.join(projectsRoot, dirName) : undefined;
  } catch {
    return undefined;
  }
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
          const text = extractText(obj.message.content).trim();
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

export function listPastSessions(
  projectDir: string,
  limit = 5,
  onlyIds?: Set<string>
): SessionInfo[] {
  const full = claudeProjectFolder(projectDir);
  if (!full) return [];
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
  if (onlyIds) {
    sessions = sessions.filter((s) => onlyIds.has(s.id));
  }
  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const top = sessions.slice(0, limit);
  for (const s of top) {
    s.title = readSessionTitle(path.join(full, `${s.id}.jsonl`));
  }
  return top;
}

// ---------- История диалога для мини-приложения ----------

export type HistoryMessage = { role: "user" | "assistant"; text: string };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string }[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n\n");
  }
  return "";
}

const SESSION_ID_RE = /^[\w.-]+$/;

export function readSessionHistory(
  projectDir: string,
  sessionId: string,
  limit = 200
): HistoryMessage[] {
  if (!SESSION_ID_RE.test(sessionId)) return [];
  const folder = claudeProjectFolder(projectDir);
  if (!folder) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(folder, `${sessionId}.jsonl`), "utf8");
  } catch {
    return [];
  }
  const out: HistoryMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        isMeta?: boolean;
        message?: { content?: unknown };
      };
      if (obj.type === "user" && obj.message && !obj.isMeta) {
        const text = extractText(obj.message.content).trim();
        // пропускаем служебные сообщения (/команды, результаты инструментов)
        if (text && !text.startsWith("<")) out.push({ role: "user", text });
      } else if (obj.type === "assistant" && obj.message) {
        const text = extractText(obj.message.content).trim();
        if (text) {
          const prev = out[out.length - 1];
          if (prev && prev.role === "assistant") {
            prev.text += "\n\n" + text; // куски одного хода — в одно сообщение
          } else {
            out.push({ role: "assistant", text });
          }
        }
      }
    } catch {
      // битая строка — пропускаем
    }
  }
  return out.slice(-limit);
}
