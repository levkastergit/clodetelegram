import * as crypto from "node:crypto";
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

// ---------- Состояние пользователей ----------
// Ключ — Telegram user id. У пользователя несколько вкладок-сессий (tabs),
// каждая привязана к проекту (или обычному чату) и сессии Claude.

export type ChatTab = {
  id: string; // внутренний id вкладки
  title: string;
  project?: string; // имя проекта; нет — обычный чат
  projectDir?: string; // абсолютный путь папки проекта
  claudeSessionId?: string; // id сессии Claude (для resume)
  createdAt: string;
  updatedAt: string;
};

export type UserState = {
  tabs: ChatTab[];
  activeTabId?: string;
  // Авто-режим: все действия Клода одобряются без подтверждений
  auto?: boolean;
  // Модель: "opus" | "sonnet" | "haiku"; не задано — модель по умолчанию
  model?: string;
  // Гостевой пользователь: доступ ограничен одним проектом и своими диалогами
  guest?: boolean;
  // Сессии Claude, созданные этим пользователем, — гостю показываются только они
  ownedSessions?: string[];

  // Старый формат (до вкладок) — поля нужны только для миграции
  mode?: "chat" | "project";
  project?: string;
  projectDir?: string;
  sessions?: Record<string, string>;
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

function newTab(partial: Partial<ChatTab>): ChatTab {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: partial.title || "Новый диалог",
    project: partial.project,
    projectDir: partial.projectDir,
    claudeSessionId: partial.claudeSessionId,
    createdAt: now,
    updatedAt: now,
  };
}

// Перевод старого формата (mode/project/sessions) во вкладки
function migrate(cs: UserState): void {
  if (cs.tabs) return;
  cs.tabs = [];
  const old = cs.sessions ?? {};
  for (const [key, claudeId] of Object.entries(old)) {
    if (key === "chat") {
      cs.tabs.push(
        newTab({ title: "Чат без проекта", claudeSessionId: claudeId })
      );
    } else if (key.startsWith("project:")) {
      const name = key.slice("project:".length);
      cs.tabs.push(
        newTab({
          title: name,
          project: name,
          projectDir:
            cs.project === name && cs.projectDir
              ? cs.projectDir
              : path.join(PROJECTS_DIR, name),
          claudeSessionId: claudeId,
        })
      );
    }
  }
  cs.activeTabId = cs.tabs[cs.tabs.length - 1]?.id;
  delete cs.mode;
  delete cs.project;
  delete cs.projectDir;
  delete cs.sessions;
}

export function getUserState(userId: number): UserState {
  const key = String(userId);
  if (!state[key]) {
    state[key] = { tabs: [] };
  }
  migrate(state[key]);
  return state[key];
}

export function createTab(
  cs: UserState,
  partial: Partial<ChatTab>
): ChatTab {
  const tab = newTab(partial);
  cs.tabs.push(tab);
  cs.activeTabId = tab.id;
  saveState();
  return tab;
}

export function getTab(cs: UserState, tabId: string): ChatTab | undefined {
  return cs.tabs.find((t) => t.id === tabId);
}

export function removeTab(cs: UserState, tabId: string): void {
  cs.tabs = cs.tabs.filter((t) => t.id !== tabId);
  if (cs.activeTabId === tabId) {
    cs.activeTabId = cs.tabs[cs.tabs.length - 1]?.id;
  }
  saveState();
}

export function touchTab(tab: ChatTab): void {
  tab.updatedAt = new Date().toISOString();
}

// Гость всегда закреплён за одним проектом
export function ensureGuestState(userId: number): UserState {
  const cs = getUserState(userId);
  if (!cs.guest) {
    cs.guest = true;
    saveState();
  }
  return cs;
}

export function cwdForTab(tab: ChatTab): string {
  if (tab.project) {
    return tab.projectDir || path.join(PROJECTS_DIR, tab.project);
  }
  return CHAT_DIR;
}

// Запоминает, что сессия Claude создана этим пользователем (фильтр для гостя)
export function recordOwnedSession(cs: UserState, sessionId: string): void {
  if (!cs.ownedSessions) cs.ownedSessions = [];
  if (!cs.ownedSessions.includes(sessionId)) {
    cs.ownedSessions.push(sessionId);
    if (cs.ownedSessions.length > 500) {
      cs.ownedSessions.splice(0, cs.ownedSessions.length - 500);
    }
  }
}

// ---------- Проекты ----------

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
  for (const p of EXTRA_PROJECTS) {
    entries.push({ name: path.basename(p), dir: p });
  }
  return entries;
}

export function guestProjectEntry(): ProjectEntry {
  return { name: GUEST_PROJECT, dir: GUEST_PROJECT_DIR };
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

export type SessionInfo = { id: string; mtime: Date; title: string };

function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

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
  limit = 10,
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

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

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
