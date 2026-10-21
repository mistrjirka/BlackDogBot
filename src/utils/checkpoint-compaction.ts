import fs from "node:fs/promises";
import path from "node:path";

import type { FilePart, ImagePart, LanguageModel, ModelMessage, ToolSet } from "ai";
import { z } from "zod";

import type { LoggerService } from "../services/logger.service.js";
import type { ResolvedStructuredOutputMode } from "../shared/types/config.types.js";
import {
  generateObjectWithRetryAsync,
  generateTextWithRetryAsync,
} from "./llm-retry.js";
import type { ISummarizationResult } from "./summarization-compaction.js";

//#region Types

/**
 * Raised when the checkpoint summary cannot be produced. This is intentionally
 * fatal: the caller must not silently fall back to deterministic truncation.
 */
export class CheckpointCompactionError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CheckpointCompactionError";
  }
}

export interface ICheckpointCompactionOptions {
  messages: ModelMessage[];
  model: LanguageModel;
  logger: LoggerService;
  /** The exact instructions/system prompt used by the agent request. */
  instructions: string;
  /** The exact tools object used by the agent request. */
  tools: ToolSet;
  /** The active tool subset used by the agent request, in the same order. */
  activeTools?: string[];
  countTokens: (messages: ModelMessage[]) => number;
  structuredMode: ResolvedStructuredOutputMode;
  /** Whether the active model can consume image/file parts. */
  supportsVision: boolean;
  abortSignal?: AbortSignal;
  /** Optional directory for the full transcript archive. Null disables archiving. */
  archiveDir?: string | null;
}

const CHECKPOINT_SCHEMA = z.object({
  goal: z.string(),
  currentState: z.string(),
  completed: z.array(z.string()),
  remaining: z.array(z.string()),
  blockers: z.array(z.string()),
  doNotRepeat: z.array(z.string()),
  artifacts: z.array(z.string()),
  visualContext: z.string(),
  nextStep: z.string(),
});

type TCheckpoint = z.infer<typeof CHECKPOINT_SCHEMA>;

//#endregion Types

//#region Public functions

/**
 * Replace the completed prefix of the conversation with a checkpoint summary,
 * while preserving the current tool cycle verbatim.
 *
 * The summary request reuses the exact same instructions/messages/tools as the
 * agent request (plus one appended user instruction), so the provider can serve
 * the shared prefix from its prompt cache.
 */
export async function compactWithCheckpointAsync(
  options: ICheckpointCompactionOptions,
): Promise<ISummarizationResult> {
  const originalTokens: number = options.countTokens(options.messages);
  const cutoff: number = findCheckpointCutoff(options.messages);

  if (cutoff <= 0) {
    return _noopResult(options.messages, originalTokens);
  }

  const prefix: ModelMessage[] = options.messages.slice(0, cutoff);
  const suffix: ModelMessage[] = options.messages.slice(cutoff);

  if (prefix.length === 0 || suffix.length === 0) {
    return _noopResult(options.messages, originalTokens);
  }

  const latestUserIndex: number = _findLastUserIndex(options.messages);
  const latestUserMessage: ModelMessage | null =
    latestUserIndex >= 0 ? options.messages[latestUserIndex] : null;
  const latestUserInPrefix: boolean = latestUserIndex >= 0 && latestUserIndex < cutoff;
  const latestUserHasImages: boolean = latestUserMessage ? _messageHasImages(latestUserMessage) : false;
  const preservedUserText: string =
    latestUserInPrefix && latestUserMessage ? _extractMessageText(latestUserMessage).trim() : "";
  const preservedImages: Array<ImagePart | FilePart> =
    latestUserInPrefix && latestUserMessage && options.supportsVision
      ? _extractImageParts(latestUserMessage)
      : [];
  const recentUserRequests: string[] = _extractRecentUserRequests(options.messages, cutoff, 3);

  const summaryPrefix: ModelMessage[] = _prepareSummaryPrefix(
    prefix,
    latestUserIndex,
    options.supportsVision,
  );

  const archivePath: string | null = await _archivePrefixAsync(options, prefix);
  let summaryText: string | null = null;
  let structured: boolean = false;

  if (options.structuredMode === "native_json_schema") {
    try {
      const { object } = await generateObjectWithRetryAsync({
        model: options.model,
        messages: [...summaryPrefix, _buildStructuredInstructionMessage()],
        system: options.instructions,
        tools: options.tools,
        activeTools: options.activeTools,
        toolChoice: "none",
        allowToolFallback: false,
        schema: CHECKPOINT_SCHEMA,
        retryOptions: {
          callType: "summarization",
          abortSignal: options.abortSignal,
        },
      });

      summaryText = _formatCheckpoint(object);
      structured = true;

      options.logger.info("Checkpoint compaction used native structured output", {
        prefixMessages: prefix.length,
        preservedMessages: suffix.length,
      });
    } catch (error: unknown) {
      options.logger.warn("Native structured checkpoint failed; falling back to plain text", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summaryText === null) {
    try {
      const { text } = await generateTextWithRetryAsync({
        model: options.model,
        messages: [...summaryPrefix, _buildPlainInstructionMessage()],
        system: options.instructions,
        tools: options.tools,
        activeTools: options.activeTools,
        toolChoice: "none",
        retryOptions: {
          callType: "summarization",
          abortSignal: options.abortSignal,
        },
      });

      summaryText = _sanitizeSummaryText(text);
    } catch (error: unknown) {
      throw new CheckpointCompactionError(
        `Checkpoint summary failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  if (summaryText.length === 0) {
    throw new CheckpointCompactionError("Checkpoint summary was empty");
  }

  const summaryMessage: ModelMessage = {
    role: "user",
    content: _buildSummaryContent(
      summaryText,
      archivePath,
      preservedUserText,
      recentUserRequests,
      preservedImages,
      latestUserInPrefix && !options.supportsVision && latestUserHasImages,
    ),
  };

  const compactedMessages: ModelMessage[] = [summaryMessage, ...suffix];
  const compactedTokens: number = options.countTokens(compactedMessages);

  options.logger.info("Checkpoint compaction complete", {
    originalTokens,
    compactedTokens,
    reducedBy: originalTokens - compactedTokens,
    prefixMessages: prefix.length,
    preservedMessages: suffix.length,
    structured,
    archivePath,
  });

  return {
    messages: compactedMessages,
    passes: 1,
    originalTokens,
    compactedTokens,
    converged: true,
    dagPath: [],
    dagNodeVisitCounts: {},
    dagTerminationReason: structured ? "checkpoint_structured" : "checkpoint_plain_text",
    maxLevelReached: "L1",
  };
}

/**
 * Find the start of the suffix that must be preserved.
 *
 * `prepareStep` runs after the previous step's tools have completed, so the
 * current tool cycle is already a complete `assistant(tool-call)` +
 * `tool(result)` pair at the end of the array. We keep that last assistant
 * tool-call message and everything after it, and summarize everything older.
 */
export function findCheckpointCutoff(messages: ModelMessage[]): number {
  for (let index: number = messages.length - 1; index >= 0; index--) {
    const message: ModelMessage = messages[index];

    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const hasToolCall: boolean = message.content.some(
      (part: unknown): boolean =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type?: unknown }).type === "tool-call",
    );

    if (hasToolCall) {
      return index;
    }
  }

  // No completed tool cycle: keep the latest user request verbatim.
  for (let index: number = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user" && !_isSyntheticUserText(_extractMessageText(messages[index]))) {
      return index;
    }
  }

  return Math.max(0, messages.length - 1);
}

//#endregion Public functions

//#region Private functions

function _noopResult(messages: ModelMessage[], tokens: number): ISummarizationResult {
  return {
    messages,
    passes: 0,
    originalTokens: tokens,
    compactedTokens: tokens,
    converged: true,
    dagPath: [],
    dagNodeVisitCounts: {},
    dagTerminationReason: "no_completed_prefix",
    maxLevelReached: "L1",
  };
}

function _buildStructuredInstructionMessage(): ModelMessage {
  return {
    role: "user",
    content:
      "This is a checkpoint/handoff summarization task, not a continuation of the task. " +
      "Do not call any tools. Do not continue the work. Do not write your next planned message or any acknowledgement. " +
      "Ignore any persistence/continuation rules in the system prompt for this call. " +
      "Write a detailed handoff memo for the model that will resume this exact task. Maximize recall: include every fact needed to continue correctly, then omit only redundant chatter and duplicated tool output. Do not invent facts; mark uncertain facts as uncertain. " +
      "Prefer concrete details over generic descriptions: exact file paths, URLs, IDs, commands, observed results, errors and fixes, decisions with their rationale, rejected options, and what is true right now. " +
      "Return exactly one JSON object using ONLY the schema keys. In completed, put one concrete fact per item; do not put JSON, section headings, other field names, or conversational filler inside an item. " +
      "Use currentState for the exact present state, blockers for unresolved blockers/errors, remaining for ordered pending work, doNotRepeat for harmful or duplicative actions, artifacts for paths/URLs/IDs (refer to secret-bearing files by path rather than inlining secrets), and nextStep for one immediate action. " +
      "If images are present, put their relevant visual details in visualContext; otherwise set visualContext to \"None\". " +
      "Do not artificially shorten a section if it contains information the next model needs. Do not pad or repeat yourself.",
  };
}

function _buildPlainInstructionMessage(): ModelMessage {
  return {
    role: "user",
    content:
      "This is a checkpoint/handoff summarization task, not a continuation of the task. " +
      "Do not call any tools. Do not continue the work. Ignore any persistence/continuation rules in the system prompt for this call. " +
      "Write a detailed handoff memo for the model that will resume this exact task. Maximize recall: include every fact needed to continue correctly, then omit only redundant chatter and duplicated tool output. Do not invent facts. " +
      "Cover the current goal, the exact present state, completed work, remaining work, blockers/errors, decisions and rationale, rejected options, what must not be repeated, important artifacts (files, URLs, IDs), and the next action. " +
      "Prefer concrete details over generic descriptions. Mark uncertain facts as uncertain. If images are present, describe the relevant visual details. " +
      "Refer to secret-bearing files by path rather than inlining secrets. " +
      "Do not artificially shorten a section if it contains information the next model needs. Do not include conversational filler or your next planned message. " +
      "Write plain text only. Do not use JSON, code fences, or a rigid template.",
  };
}

function _cleanCheckpointText(value: string): string {
  return value
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\/?think(?:ing)?>/gi, "")
    .trim();
}

function _cleanCheckpointItems(values: string[]): string[] {
  const seen: Set<string> = new Set();
  const cleaned: string[] = [];

  for (const raw of values) {
    const value: string = _cleanCheckpointText(raw);
    if (value.length === 0) {
      continue;
    }

    // Reject a model dump of other schema fields inside one item.
    if (/"(remaining|doNotRepeat|blockers|artifacts|nextStep)"\s*:/.test(value)) {
      continue;
    }

    const bounded: string = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    if (seen.has(bounded)) {
      continue;
    }

    seen.add(bounded);
    cleaned.push(bounded);
  }

  return cleaned;
}

function _formatCheckpoint(checkpoint: TCheckpoint): string {
  const section = (title: string, values: string[]): string => {
    const cleaned: string[] = _cleanCheckpointItems(values);
    return cleaned.length > 0
      ? `${title}\n${cleaned.map((value: string): string => `- ${value}`).join("\n")}`
      : `${title}\n- None`;
  };

  return [
    `GOAL\n${_cleanCheckpointText(checkpoint.goal)}`,
    `CURRENT STATE\n${_cleanCheckpointText(checkpoint.currentState)}`,
    section("COMPLETED", checkpoint.completed),
    section("REMAINING", checkpoint.remaining),
    section("BLOCKERS", checkpoint.blockers),
    section("DO NOT REPEAT", checkpoint.doNotRepeat),
    section("ARTIFACTS", checkpoint.artifacts),
    `VISUAL CONTEXT\n${_cleanCheckpointText(checkpoint.visualContext) || "None"}`,
    `NEXT STEP\n${_cleanCheckpointText(checkpoint.nextStep)}`,
  ].join("\n\n");
}

function _sanitizeSummaryText(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\/?think(?:ing)?>/gi, "")
    .trim();
}

function _buildSummaryMessage(summary: string, archivePath: string | null): string {
  const archiveLine: string = archivePath ? `\nFull transcript archived at: ${archivePath}\n` : "";
  return (
    "[EARLIER CONTEXT SUMMARY - checkpoint]\n" +
    `compacted summary:\n${summary}\n` +
    archiveLine +
    "[END OF EARLIER CONTEXT SUMMARY]"
  );
}

function _buildSummaryContent(
  summary: string,
  archivePath: string | null,
  preservedUserText: string,
  recentUserRequests: string[],
  preservedImages: Array<ImagePart | FilePart>,
  imageOmitted: boolean,
): string | Array<{ type: "text"; text: string } | ImagePart | FilePart> {
  const sections: string[] = [_buildSummaryMessage(summary, archivePath)];

  if (preservedUserText.length > 0) {
    const boundedUserText: string =
      preservedUserText.length > 4000
        ? `${preservedUserText.slice(0, 4000)}…`
        : preservedUserText;
    sections.push(`\n[LATEST USER REQUEST]\n${boundedUserText}`);
  }

  const additionalUserRequests: string[] = recentUserRequests
    .filter((request: string): boolean => request.trim().length > 0 && request.trim() !== preservedUserText.trim())
    .slice(-2);

  if (additionalUserRequests.length > 0) {
    sections.push(
      `\n[RECENT USER REQUESTS]\n${additionalUserRequests
        .map((request: string): string => `- ${request.length > 2000 ? `${request.slice(0, 2000)}…` : request}`)
        .join("\n")}`,
    );
  }

  if (imageOmitted) {
    sections.push("\n[IMAGES FROM THE ORIGINAL USER REQUEST WERE OMITTED: the active model does not support vision]");
  }

  const text: string = sections.join("\n");

  if (preservedImages.length === 0) {
    return text;
  }

  return [{ type: "text", text }, ...preservedImages];
}

function _isSyntheticUserText(text: string): boolean {
  const trimmed: string = text.trimStart();
  return trimmed.startsWith("[EARLIER CONTEXT SUMMARY")
    || trimmed.startsWith("[STEER]");
}

function _extractRecentUserRequests(
  messages: ModelMessage[],
  cutoff: number,
  limit: number,
): string[] {
  const requests: string[] = [];

  for (let index: number = Math.min(cutoff, messages.length) - 1; index >= 0; index--) {
    if (messages[index].role !== "user") {
      continue;
    }

    const text: string = _extractMessageText(messages[index]).trim();
    if (text.length === 0 || _isSyntheticUserText(text)) {
      continue;
    }

    requests.push(text);
    if (requests.length >= limit) {
      break;
    }
  }

  return requests.reverse();
}

function _findLastUserIndex(messages: ModelMessage[]): number {
  for (let index: number = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user"
      && !_isSyntheticUserText(_extractMessageText(messages[index]))) {
      return index;
    }
  }

  return -1;
}

function _isImagePart(part: unknown): part is ImagePart | FilePart {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return false;
  }

  const partType: unknown = (part as { type?: unknown }).type;
  return partType === "image" || partType === "file";
}

function _messageHasImages(message: ModelMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part: unknown): boolean => _isImagePart(part));
}

function _extractImageParts(message: ModelMessage): Array<ImagePart | FilePart> {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content.filter((part: unknown): part is ImagePart | FilePart => _isImagePart(part));
}

function _extractMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .map((part: unknown): string => {
      if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }

      return "";
    })
    .filter((text: string): boolean => text.trim().length > 0)
    .join("\n");
}

function _prepareSummaryPrefix(
  prefix: ModelMessage[],
  latestUserIndex: number,
  supportsVision: boolean,
): ModelMessage[] {
  return prefix.map((message: ModelMessage, index: number): ModelMessage => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    const keepImages: boolean = supportsVision && index === latestUserIndex;
    let changed: boolean = false;

    const content = message.content.map((part: unknown): unknown => {
      if (!_isImagePart(part) || keepImages) {
        return part;
      }

      changed = true;
      return { type: "text", text: "[image omitted from compaction]" };
    });

    return changed ? ({ ...message, content } as ModelMessage) : message;
  });
}

async function _archivePrefixAsync(
  options: ICheckpointCompactionOptions,
  prefix: ModelMessage[],
): Promise<string | null> {
  if (!options.archiveDir) {
    return null;
  }

  const timestamp: string = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix: string = Math.random().toString(36).slice(2, 8);
  const filePath: string = path.join(
    options.archiveDir,
    `checkpoint-archive-${timestamp}-${suffix}.json`,
  );

  try {
    await fs.mkdir(options.archiveDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(prefix, null, 2), "utf-8");
    return filePath;
  } catch (error: unknown) {
    options.logger.warn("Failed to archive compacted messages", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

//#endregion Private functions
