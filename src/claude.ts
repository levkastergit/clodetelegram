import {
  query,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHAT_DIR, GUEST_PROJECT } from "./config.js";
import {
  cwdFor,
  getUserState,
  recordOwnedSession,
  saveState,
  sessionKey,
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

const running = new Map<number, AbortController>(); // userId -> контроллер

export function isRunning(userId: number): boolean {
  return running.has(userId);
}

export function stopTurn(userId: number): boolean {
  const ac = running.get(userId);
  if (!ac) return false;
  ac.abort();
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

// Инструменты, которые гостю одобряются автоматически (после проверки путей)
const GUEST_AUTO_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
]);
// Инструменты с путями: разрешены только внутри папки гостевого проекта
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

// Возвращает причину отказа или null, если инструмент гостю разрешён
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

// ---------- Запуск одного «хода» Клода ----------

export async function runTurn(
  userId: number,
  text: string,
  io: TurnIO
): Promise<TurnResult> {
  const cs = getUserState(userId);
  const key = sessionKey(cs);
  const cwd = cwdFor(cs);
  fs.mkdirSync(cwd, { recursive: true });

  if (running.has(userId)) {
    return { error: "Предыдущая задача ещё выполняется." };
  }
  const abortController = new AbortController();
  running.set(userId, abortController);

  // canUseTool вызывается для инструментов, не разрешённых автоматически —
  // спрашиваем подтверждение через io (кнопки в мини-приложении).
  const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    // Вопрос Клода с вариантами — показываем кнопки и возвращаем выбор
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

    // Авто-режим: всё остальное одобряется без подтверждений
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
        resume: cs.sessions[key],
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
        // Гостю ничего не разрешаем заранее: каждый инструмент проходит
        // проверку путей в canUseTool; Bash и субагенты запрещены совсем.
        allowedTools: cs.guest
          ? []
          : ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task"],
        disallowedTools: cs.guest ? ["Bash", "Task"] : undefined,
        canUseTool,
        abortController,
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        cs.sessions[key] = message.session_id;
        recordOwnedSession(cs, message.session_id);
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
        cs.sessions[key] = message.session_id;
        recordOwnedSession(cs, message.session_id);
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
    running.delete(userId);
  }
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

export async function getLimitsLines(): Promise<string[]> {
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
      return [
        "Данные о лимитах недоступны (для этого способа входа план-лимиты не применяются).",
      ];
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
    return lines;
  } finally {
    q.close();
  }
}
