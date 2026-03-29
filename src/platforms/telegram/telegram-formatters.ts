import type { IToolCallSummary } from "../../agent/types.js";

//#region Constants

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
  const truncated: string = value.length > 60 ? `${value.slice(0, 60)}...` : value;

  return reasoningSuffix.length > 0
    ? `${name}(${truncated}) ${reasoningSuffix}`
    : `${name}(${truncated})`;
}

export function formatStepTraceLines(stepNumber: number, toolCalls: IToolCallSummary[]): string | null {
  if (toolCalls.length === 0) {
    return null;
  }

  const formatted: string = toolCalls
    .map((toolCall: IToolCallSummary): string => formatToolCallForTelegram(toolCall.name, toolCall.input))
    .join(", ");

  return `Step ${stepNumber}: ${formatted}`;
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
