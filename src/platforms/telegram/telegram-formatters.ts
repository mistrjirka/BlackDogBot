import type { IToolCallSummary } from "../../agent/types.js";

//#region Constants

const CronTools: ReadonlySet<string> = new Set(["add_cron", "edit_cron", "edit_cron_instructions"]);

const ToolPrimaryKeyByName: Record<string, string> = {
  run_cmd: "command",
  fetch_rss: "url",
  search_knowledge: "query",
  add_knowledge: "knowledge",
  edit_knowledge: "id",
  call_skill: "skillName",
  get_skill_file: "skillName",
  modify_prompt: "promptName",
  send_message: "message",
  read_file: "filePath",
  write_file: "filePath",
  append_file: "filePath",
  edit_file: "filePath",
  add_cron: "name",
  edit_cron: "taskId",
  edit_cron_instructions: "taskId",
  remove_cron: "taskId",
  get_cron: "taskId",
  list_crons: "taskId",
  run_cron: "taskId",
  think: "thought",
};

//#endregion Constants

//#region Public Functions

export function formatToolCallForTelegram(name: string, input: Record<string, unknown>): string {
  const key: string | undefined = ToolPrimaryKeyByName[name];
  const reasoningSuffix: string = formatReasoningSuffix(input);

  if (!key || !(key in input)) {
    return reasoningSuffix.length > 0 ? `${name} ${reasoningSuffix}` : name;
  }

  const value: string = String(input[key] ?? "");

  if (CronTools.has(name)) {
    return formatCronToolCall(name, input, reasoningSuffix);
  }

  const truncated: string = value.length > 60 ? `${value.slice(0, 60)}...` : value;

  return reasoningSuffix.length > 0
    ? `${name}(${truncated}) ${reasoningSuffix}`
    : `${name}(${truncated})`;
}

export function formatStepTraceLines(stepNumber: number, toolCalls: IToolCallSummary[]): string | null {
  if (toolCalls.length === 0) {
    return null;
  }

  const formatted: string[] = toolCalls
    .map((toolCall: IToolCallSummary): string => {
      const toolLine: string = formatToolCallForTelegram(toolCall.name, toolCall.input);
      const resultLine: string | null = formatToolResultForTelegram(toolCall.name, toolCall.result, toolCall.isError);
      return resultLine ? `${toolLine}\n  ${resultLine}` : toolLine;
    });

  return `Step ${stepNumber}: ${formatted.join("\n")}`;
}

export function buildCancelResponseText(
  stopped: boolean,
  deletedInFlightMessage: boolean,
  droppedQueuedMessages: number,
): string {
  if (!stopped && !deletedInFlightMessage && droppedQueuedMessages === 0) {
    return "Nothing to cancel.";
  }

  const details: string[] = [];
  if (stopped) {
    details.push("stopped current generation");
  }
  if (deletedInFlightMessage) {
    details.push("deleted progress message");
  }
  if (droppedQueuedMessages > 0) {
    details.push(`cleared ${droppedQueuedMessages} queued message${droppedQueuedMessages > 1 ? "s" : ""}`);
  }

  return `Cancelled: ${details.join(", ")}.`;
}

export function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function detectThinkLeakInModelText(text: string): { hasThinkTags: boolean; hasReasoningPhrases: boolean } {
  const hasThinkTags: boolean = /<\/?(think|thinking|reasoning)>/i.test(text);
  const hasReasoningPhrases: boolean =
    /\b(the user is asking|i should|let me think|i need to|my approach)\b/i.test(text);

  return {
    hasThinkTags,
    hasReasoningPhrases,
  };
}

//#endregion Public Functions

//#region Private Functions

function formatCronToolCall(name: string, input: Record<string, unknown>, reasoningSuffix: string): string {
  const parts: string[] = [];

  if (name === "add_cron") {
    parts.push(`name: "${input.name ?? "?"}"`);
    if (input.scheduleType === "once") {
      parts.push(`schedule: once at ${input.scheduleRunAt}`);
    } else if (input.scheduleType === "interval") {
      parts.push(`schedule: every ${input.scheduleIntervalMs}ms`);
    } else if (input.scheduleType === "scheduled") {
      const hh = input.scheduleStartHour !== null && input.scheduleStartHour !== undefined
        ? String(input.scheduleStartHour).padStart(2, "0")
        : null;
      const mm = input.scheduleStartMinute !== null && input.scheduleStartMinute !== undefined
        ? String(input.scheduleStartMinute).padStart(2, "0")
        : null;
      const timeStr = hh !== null && mm !== null ? ` at ${hh}:${mm}` : mm !== null ? ` at :${mm}` : "";
      parts.push(`schedule: every ${input.scheduleIntervalMinutes}min${timeStr}`);
    }
    if (Array.isArray(input.tools)) {
      parts.push(`tools: [${input.tools.join(", ")}]`);
    }
    if (typeof input.instructions === "string" && input.instructions.length > 0) {
      const preview: string = input.instructions.length > 80 ? `${input.instructions.slice(0, 80)}...` : input.instructions;
      parts.push(`instructions: "${preview}"`);
    }
  } else if (name === "edit_cron") {
    parts.push(`taskId: ${input.taskId ?? "?"}`);
    const patchFields: string[] = [];
    if (input.name !== undefined) patchFields.push(`name="${input.name}"`);
    if (input.description !== undefined) patchFields.push(`description`);
    if (input.tools !== undefined) patchFields.push(`tools=[${(input.tools as string[]).join(", ")}]`);
    if (input.scheduleType !== undefined) patchFields.push(`schedule=${input.scheduleType}`);
    if (input.enabled !== undefined) patchFields.push(`enabled=${input.enabled}`);
    if (input.notifyUser !== undefined) patchFields.push(`notifyUser=${input.notifyUser}`);
    if (patchFields.length > 0) {
      parts.push(`patch: ${patchFields.join(", ")}`);
    }
  } else if (name === "edit_cron_instructions") {
    parts.push(`taskId: ${input.taskId ?? "?"}`);
    if (typeof input.instructions === "string") {
      const preview: string = input.instructions.length > 80 ? `${input.instructions.slice(0, 80)}...` : input.instructions;
      parts.push(`instructions: "${preview}"`);
    }
    if (input.tools !== undefined) {
      parts.push(`tools: [${(input.tools as string[]).join(", ")}]`);
    }
  }

  const callLine: string = parts.length > 0 ? `${name}(${parts.join(", ")})` : name;
  return reasoningSuffix.length > 0 ? `${callLine} ${reasoningSuffix}` : callLine;
}

function formatToolResultForTelegram(name: string, result: unknown, isError?: boolean): string | null {
  if (result === undefined || result === null) {
    return null;
  }

  if (CronTools.has(name)) {
    return formatCronToolResult(name, result, isError);
  }

  return formatGenericToolResult(result, isError);
}

function formatCronToolResult(name: string, result: unknown, isError?: boolean): string | null {
  if (typeof result !== "object" || result === null) {
    return formatGenericToolResult(result, isError);
  }

  const res = result as Record<string, unknown>;

  if (res.success === false) {
    const error: string = typeof res.error === "string" ? res.error : "Unknown error";
    return `❌ ${error}`;
  }

  if (res.success === true) {
    if (name === "add_cron") {
      return `✅ Created task ${res.taskId}`;
    }

    if (name === "edit_cron" || name === "edit_cron_instructions") {
      const task = res.task as Record<string, unknown> | undefined;
      const display = res.display as string | undefined;
      if (task) {
        return `✅ Updated task ${task.taskId} "${task.name}"`;
      }
      if (display) {
        return `✅ Updated`;
      }
      return "✅ Updated";
    }
  }

  return formatGenericToolResult(result, isError);
}

function formatGenericToolResult(result: unknown, _isError?: boolean): string | null {
  if (typeof result === "object" && result !== null) {
    const res = result as Record<string, unknown>;

    if (res.success === false && typeof res.error === "string") {
      return `❌ ${res.error}`;
    }

    if (res.success === true && typeof res.message === "string" && res.message.length > 0) {
      return `✅ ${res.message}`;
    }

    if (typeof res.message === "string" && res.message.length > 0) {
      return res.message;
    }
  }

  if (typeof result === "string" && result.length > 0) {
    return result.length > 200 ? `${result.slice(0, 200)}...` : result;
  }

  return null;
}

function formatReasoningSuffix(input: Record<string, unknown>): string {
  const reasoningValue: unknown = input.reasoning;

  if (typeof reasoningValue !== "string") {
    return "";
  }

  const trimmed: string = reasoningValue.trim();

  if (trimmed.length === 0) {
    return "";
  }

  const preview: string = trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;

  return `[reasoning: ${preview}]`;
}

//#endregion Private Functions
