import type { LanguageModel, ModelMessage } from "ai";

import { LoggerService } from "../services/logger.service.js";
import { generateTextWithRetryAsync } from "./llm-retry.js";

//#region Constants

const MAX_SUMMARIZATION_PASSES: number = 4;
const CHUNK_OVERLAP_MESSAGES: number = 1;
const MIN_CHUNK_MESSAGES: number = 3;
const MAX_CHUNK_MESSAGES: number = 24;

//#endregion Constants

//#region Interfaces

export interface ISummarizationResult {
  messages: ModelMessage[];
  passes: number;
  originalTokens: number;
  compactedTokens: number;
  converged: boolean;
}

//#endregion Interfaces

//#region Public functions

export async function compactMessagesSummaryOnlyAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): Promise<ISummarizationResult> {
  const originalTokens: number = countTokens(messages);

  if (messages.length <= 2 || originalTokens <= targetTokenCount) {
    return {
      messages,
      passes: 0,
      originalTokens,
      compactedTokens: originalTokens,
      converged: true,
    };
  }

  let currentMessages: ModelMessage[] = messages;
  let previousTokens: number = originalTokens;
  let passes: number = 0;
  let converged: boolean = false;

  for (let passIndex: number = 0; passIndex < MAX_SUMMARIZATION_PASSES; passIndex++) {
    const tokensBefore: number = countTokens(currentMessages);
    if (tokensBefore <= targetTokenCount) {
      converged = true;
      break;
    }

    const compacted = await _compactSinglePassAsync(
      currentMessages,
      model,
      logger,
      targetTokenCount,
      countTokens,
      passIndex,
    );

    const tokensAfter: number = countTokens(compacted);
    passes = passIndex + 1;

    logger.info("Summary-only compaction pass finished", {
      pass: passes,
      before: tokensBefore,
      after: tokensAfter,
      reducedBy: tokensBefore - tokensAfter,
    });

    if (tokensAfter <= targetTokenCount) {
      currentMessages = compacted;
      converged = true;
      break;
    }

    if (tokensAfter >= previousTokens) {
      logger.warn("Summary compaction stalled (no further reduction)", {
        pass: passes,
        previousTokens,
        currentTokens: tokensAfter,
      });
      currentMessages = compacted;
      break;
    }

    previousTokens = tokensAfter;
    currentMessages = compacted;
  }

  const compactedTokens: number = countTokens(currentMessages);

  logger.info("Summary-only compaction complete", {
    originalTokens,
    compactedTokens,
    passes,
    converged,
  });

  return {
    messages: currentMessages,
    passes,
    originalTokens,
    compactedTokens,
    converged,
  };
}

//#endregion Public functions

//#region Private functions

async function _compactSinglePassAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
  passIndex: number,
): Promise<ModelMessage[]> {
  if (messages.length <= 2) {
    return messages;
  }

  const firstMessage: ModelMessage = messages[0];
  const keepRecentCount: number = _getKeepRecentCount(passIndex, messages.length);
  const recentMessages: ModelMessage[] = messages.slice(-keepRecentCount);
  const oldMessages: ModelMessage[] = messages.slice(1, -keepRecentCount);

  if (oldMessages.length === 0) {
    return messages;
  }

  const summaryBudgetTokens: number = Math.max(
    700,
    Math.floor(targetTokenCount - countTokens([firstMessage, ...recentMessages]) - 180),
  );

  const summaryText: string = await _summarizeMessagesMapReduceAsync(
    oldMessages,
    model,
    logger,
    summaryBudgetTokens,
  );

  const summaryMessage: ModelMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `[CONVERSATION SUMMARY - Earlier messages were compacted]\n\n${summaryText}\n\n[END OF SUMMARY - Recent conversation follows]`,
      },
    ],
  };

  return [firstMessage, summaryMessage, ...recentMessages];
}

function _getKeepRecentCount(passIndex: number, messageCount: number): number {
  if (passIndex <= 0) {
    return Math.min(6, Math.max(2, messageCount - 1));
  }

  if (passIndex === 1) {
    return Math.min(4, Math.max(2, messageCount - 1));
  }

  return Math.min(2, Math.max(1, messageCount - 1));
}

async function _summarizeMessagesMapReduceAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetSummaryTokens: number,
): Promise<string> {
  const chunkSize: number = _pickChunkSize(messages.length);
  const chunks: ModelMessage[][] = _chunkMessages(messages, chunkSize, CHUNK_OVERLAP_MESSAGES);

  const partialSummaries: string[] = [];
  for (let i: number = 0; i < chunks.length; i++) {
    const chunkText: string = _messagesToPlainText(chunks[i]);
    const chunkTargetTokens: number = Math.max(220, Math.floor(targetSummaryTokens / Math.max(chunks.length, 1)));
    const chunkSummary: string = await _summarizeTextAsync(
      model,
      logger,
      chunkText,
      chunkTargetTokens,
      `chunk_${i + 1}`,
    );
    partialSummaries.push(chunkSummary);
  }

  let merged: string = partialSummaries.join("\n\n");
  let mergePass: number = 0;

  while (_estimateTokens(merged) > targetSummaryTokens && mergePass < 3) {
    mergePass++;
    merged = await _summarizeTextAsync(
      model,
      logger,
      merged,
      targetSummaryTokens,
      `reduce_${mergePass}`,
    );
  }

  return merged;
}

async function _summarizeTextAsync(
  model: LanguageModel,
  logger: LoggerService,
  sourceText: string,
  targetTokens: number,
  phase: string,
): Promise<string> {
  try {
    const targetChars: number = Math.max(300, targetTokens * 4);
    const result = await generateTextWithRetryAsync({
      model,
      prompt:
        `Summarize the following conversation excerpt. ` +
        `Keep key decisions, actions, concrete facts, identifiers, and pending tasks. ` +
        `Target length: about ${targetChars} characters.\n\n` +
        `Conversation excerpt:\n${sourceText}`,
    });

    return result.text && result.text.trim().length > 0
      ? result.text.trim()
      : `[Summary unavailable for phase ${phase}]`;
  } catch (error: unknown) {
    logger.warn("Chunk summarization failed", {
      phase,
      error: error instanceof Error ? error.message : String(error),
      sourceLength: sourceText.length,
    });

    const approxTokens: number = _estimateTokens(sourceText);
    return `[Summary unavailable (${phase}, source~${approxTokens} tokens).]`;
  }
}

function _messagesToPlainText(messages: ModelMessage[]): string {
  return messages
    .map((msg: ModelMessage): string => {
      if (msg.role === "user") {
        return `[User]: ${_extractTextContent(msg)}`;
      }

      if (msg.role === "assistant") {
        return `[Assistant]: ${_extractTextContent(msg)}`;
      }

      if (msg.role === "tool") {
        return `[Tool result]: ${_extractTextContent(msg)}`;
      }

      return `[${msg.role}]: ${_extractTextContent(msg)}`;
    })
    .join("\n");
}

function _extractTextContent(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  const parts: string[] = [];
  for (const part of message.content) {
    if ("text" in part && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }

    if ("type" in part && part.type === "tool-call") {
      const toolCall = part as {
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        input?: unknown;
      };
      parts.push(JSON.stringify({
        type: "tool-call",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args ?? toolCall.input,
      }));
      continue;
    }

    if ("result" in part || "output" in part) {
      const resPart = part as {
        toolCallId?: string;
        result?: unknown;
        output?: unknown;
        isError?: boolean;
      };
      parts.push(JSON.stringify({
        toolCallId: resPart.toolCallId,
        result: resPart.result ?? resPart.output,
        isError: resPart.isError,
      }));
    }
  }

  return parts.join(" ");
}

function _pickChunkSize(messageCount: number): number {
  if (messageCount <= MIN_CHUNK_MESSAGES) {
    return MIN_CHUNK_MESSAGES;
  }

  if (messageCount >= 120) {
    return MAX_CHUNK_MESSAGES;
  }

  return Math.min(MAX_CHUNK_MESSAGES, Math.max(MIN_CHUNK_MESSAGES, Math.floor(messageCount / 5)));
}

function _chunkMessages(
  messages: ModelMessage[],
  chunkSize: number,
  overlap: number,
): ModelMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const chunks: ModelMessage[][] = [];
  const stride: number = Math.max(1, chunkSize - overlap);

  for (let start: number = 0; start < messages.length; start += stride) {
    const end: number = Math.min(messages.length, start + chunkSize);
    const chunk: ModelMessage[] = messages.slice(start, end);
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= messages.length) {
      break;
    }
  }

  return chunks;
}

function _estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

//#endregion Private functions
