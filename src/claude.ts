import {
  query,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHAT_DIR, GUEST_PROJECT } from "./config.js";
import {
  cwdForTab,
  recordOwnedSession,
  saveState,
  touchTab,
  type ChatTab,
  type UserState,
} from "./state.js";

// ---------- Интерфейс «хода» Клода, не зависящий от Telegram/веба ----------

export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

export type TurnIO = {
  status(text: string): void;
  askApproval(description: string, signal: AbortSignal): Promise<boolean>;
  askQuestion(q: AskQuestion, signal: AbortSignal): Promise<string | null>;
};

export type TurnResult = {
  text?: string;
  error?: string;
  aborted?: boolean;
};

// Одновременно может работать несколько вкладок (ходов) — каждая со своим
// контроллером. Ограничиваем число параллельных задач на пользователя.
const MAX_PARALLEL_PER_USER = 3;
const running = new Map<string, { userId: number; ac: AbortController }>();

export function isTabRunning(tabId: string): boolean {
  return running.has(tabId);
}

export function runningCountFor(userId: number): number {
  let n = 0;
  for (const r of running.values()) if (r.userId === userId) n++;
  return n;
}

export function stopTab(tabId: string): boolean {
  const r = running.get(tabId);
  if (!r) return false;
  r.ac.abort();
  return true;
}

export function describeToolUse(
  name: string,
  input: Record<string, unknown>
): string {
  if (name === "Bash" && typeof input.command === "string") {
    return `Bash: ${input.command}`;
  }
  if (typeof input.file_path === "string") {
    return `${name}: ${input.file_path}`;
  }
  const brief = JSON.stringify(input);
  return `${name}: ${brief.length > 200 ? brief.slice(0, 200) + "…" : brief}`;
}

// ---------- Ограничения инструментов для гостя ----------

const GUEST_AUTO_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
]);
const GUEST_PATH_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
]);

function guestToolDenial(
  toolName: string,
  input: Record<string, unknown>,
  projectDir: string
): string | null {
  if (
    toolName === "AskUserQuestion" ||
    toolName === "TodoWrite" ||
    toolName === "WebSearch" ||
    toolName === "WebFetch"
  ) {
    return null;
  }
  if (!GUEST_PATH_TOOLS.has(toolName)) {
    return `Инструмент ${toolName} недоступен для гостевого аккаунта`;
  }
  const root = path.resolve(projectDir);
  for (const field of ["file_path", "path", "notebook_path"]) {
    const v = input[field];
    if (typeof v === "string" && v.trim()) {
      const rel = path.relative(root, path.resolve(root, v));
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return `Гостевому аккаунту доступны только файлы внутри проекта «${GUEST_PROJECT}»`;
      }
    }
  }
  return null;
}

const GUEST_PROMPT_APPEND =
  " ВАЖНО: с ботом работает гостевой пользователь с ограниченным доступом. " +
  "Работай только с файлами внутри текущей папки проекта. " +
  "Запрещено раскрывать гостю любую личную информацию владельца бота: " +
  "имена и учётные записи, пути и файлы вне папки проекта, переменные окружения, " +
  "токены и ключи, список других проектов, историю других диалогов, данные подписки. " +
  "Если гость просит что-то из этого — вежливо откажись.";

// ---------- Запуск одного «хода» Клода во вкладке ----------

export async function runTurn(
  userId: number,
  cs: UserState,
  tab: ChatTab,
  text: string,
  io: TurnIO
): Promise<TurnResult> {
  const cwd = cwdForTab(tab);
  fs.mkdirSync(cwd, { recursive: true });

  if (running.has(tab.id)) {
    return { error: "В этой сессии задача ещё выполняется." };
  }
  if (runningCountFor(userId) >= MAX_PARALLEL_PER_USER) {
    return {
      error: `Слишком много параллельных задач (максимум ${MAX_PARALLEL_PER_USER}). Дождитесь завершения или остановите одну из них.`,
    };
  }
  const abortController = new AbortController();
  running.set(tab.id, { userId, ac: abortController });

  const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    if (toolName === "AskUserQuestion") {
      const questions = (input as { questions?: AskQuestion[] }).questions;
      if (Array.isArray(questions) && questions.length > 0) {
        const answers: Record<string, string> = {};
        for (const qu of questions) {
          const answer = await io.askQuestion(qu, signal);
          if (answer === null) {
            return { behavior: "deny", message: "Пользователь не ответил на вопрос" };
          }
          answers[qu.question] = answer;
        }
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }
    }

    // Ограничения гостя проверяются ДО авто-режима, их нельзя обойти настройками
    if (cs.guest) {
      const denial = guestToolDenial(toolName, input as Record<string, unknown>, cwd);
      if (denial) {
        return { behavior: "deny", message: denial };
      }
      if (GUEST_AUTO_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    if (cs.auto) {
      return { behavior: "allow", updatedInput: input };
    }

    const allowed = await io.askApproval(
      describeToolUse(toolName, input as Record<string, unknown>),
      signal
    );
    const result: PermissionResult = allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Пользователь отклонил действие" };
    return result;
  };

  try {
    io.status("⏳ Думаю…");

    let finalText = "";
    let resultError: string | undefined;

    for await (const message of query({
      prompt: text,
      options: {
        cwd,
        resume: tab.claudeSessionId,
        model: cs.model,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "Твой ответ будет показан в мини-приложении Telegram: пиши кратко, обычным текстом, без markdown-таблиц. " +
            "Если нужно спросить пользователя и предложить варианты ответа — вызывай инструмент AskUserQuestion." +
            (cs.guest ? GUEST_PROMPT_APPEND : ""),
        },
        permissionMode: "acceptEdits",
        allowedTools: cs.guest
          ? []
          : ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task"],
        disallowedTools: cs.guest ? ["Bash", "Task"] : undefined,
        canUseTool,
        abortController,
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        tab.claudeSessionId = message.session_id;
        recordOwnedSession(cs, message.session_id);
        touchTab(tab);
        saveState();
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            io.status(
              `🔧 ${describeToolUse(block.name, block.input as Record<string, unknown>)}`
            );
          }
        }
      } else if (message.type === "result") {
        tab.claudeSessionId = message.session_id;
        recordOwnedSession(cs, message.session_id);
        touchTab(tab);
        saveState();
        if (message.subtype === "success") {
          finalText = message.result;
        } else {
          resultError = message.subtype;
        }
      }
    }

    if (abortController.signal.aborted) return { aborted: true };
    if (finalText) return { text: finalText };
    if (resultError) return { error: `Задача завершилась с ошибкой: ${resultError}` };
    return { text: "Клод завершил работу без текстового ответа." };
  } catch (err) {
    if (abortController.signal.aborted) return { aborted: true };
    console.error("Ошибка выполнения запроса:", err);
    return {
      error: `Произошла ошибка: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    running.delete(tab.id);
  }
}

// ---------- Лимиты подписки ----------
// Используется экспериментальный метод SDK (shape может поменяться при обновлении
// пакета) — он возвращает те же данные, что экран /usage в Claude Code.

export type LimitWindow = {
  label: string;
  pct: number;
  resetsAt: string | null;
};

export type LimitsInfo = {
  subscription: string;
  windows: LimitWindow[];
  extra?: string;
};

function windowOf(
  label: string,
  w: { utilization: number | null; resets_at: string | null } | null | undefined
): LimitWindow | null {
  if (!w || w.utilization === null || w.utilization === undefined) return null;
  return {
    label,
    pct: Math.round(w.utilization),
    resetsAt: w.resets_at,
  };
}

export async function getLimits(): Promise<LimitsInfo> {
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
      return { subscription: usage.subscription_type ?? "неизвестно", windows: [] };
    }
    const windows = [
      windowOf("Сессия (5 ч)", rl.five_hour),
      windowOf("Неделя (7 дн)", rl.seven_day),
      windowOf("Неделя, Opus", rl.seven_day_opus),
      windowOf("Неделя, Sonnet", rl.seven_day_sonnet),
      ...(rl.model_scoped ?? []).map((m) =>
        windowOf(`Неделя, ${m.display_name}`, m)
      ),
    ].filter((w): w is LimitWindow => w !== null);
    let extra: string | undefined;
    if (rl.extra_usage?.is_enabled && rl.extra_usage.utilization !== null) {
      extra =
        `Доп. кредиты: ${Math.round(rl.extra_usage.utilization ?? 0)}%` +
        (rl.extra_usage.used_credits !== null
          ? ` (${rl.extra_usage.used_credits} ${rl.extra_usage.currency ?? ""})`
          : "");
    }
    return {
      subscription: usage.subscription_type ?? "неизвестно",
      windows,
      extra,
    };
  } finally {
    q.close();
  }
}
