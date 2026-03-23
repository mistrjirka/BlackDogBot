import type { LanguageModel, ModelMessage } from "ai";

import { LoggerService } from "../services/logger.service.js";
import { generateTextWithRetryAsync } from "./llm-retry.js";

//#region Constants

const MAX_SUMMARIZATION_PASSES: number = 2;

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
  forced: boolean = false,
): Promise<ISummarizationResult> {
  const originalTokens: number = countTokens(messages);

  if (messages.length <= 2 || (!forced && originalTokens <= targetTokenCount)) {
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
    const mustRunForcedPass: boolean = forced && passIndex === 0;
    if (!mustRunForcedPass && tokensBefore <= targetTokenCount) {
      converged = true;
      break;
    }

    const compacted = await _compactSinglePassAsync(
      currentMessages,
      model,
      logger,
      targetTokenCount,
      countTokens,
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
): Promise<ModelMessage[]> {
  if (messages.length <= 2) {
    return messages;
  }

  const stageAResult: ModelMessage[] = await _compactPrefixBeforeLastUserAsync(
    messages,
    model,
    logger,
    targetTokenCount,
    countTokens,
  );

  if (countTokens(stageAResult) <= targetTokenCount) {
    return stageAResult;
  }

  const stageBResult: ModelMessage[] = await _compactLatestUserMessageAsync(
    stageAResult,
    model,
    logger,
    targetTokenCount,
    countTokens,
  );

  if (countTokens(stageBResult) <= targetTokenCount) {
    return stageBResult;
  }

  const stageCResult: ModelMessage[] = await _compactToolResultsAfterLatestUserAsync(
    stageBResult,
    model,
    logger,
    targetTokenCount,
    countTokens,
  );

  return stageCResult;
}

function _findLastUserIndex(messages: ModelMessage[]): number {
  for (let i: number = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return i;
    }
  }

  return -1;
}

async function _compactPrefixBeforeLastUserAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): Promise<ModelMessage[]> {
  const lastUserIndex: number = _findLastUserIndex(messages);

  if (lastUserIndex <= 1) {
    return messages;
  }

  const firstMessage: ModelMessage = messages[0];
  const prefixMessages: ModelMessage[] = messages.slice(1, lastUserIndex);
  const activeSuffix: ModelMessage[] = messages.slice(lastUserIndex);
  const pinnedSummaryMessages: ModelMessage[] = prefixMessages.filter((message: ModelMessage): boolean =>
    _isEarlierContextSummaryMessage(message),
  );
  const unpinnedPrefixMessages: ModelMessage[] = prefixMessages.filter((message: ModelMessage): boolean =>
    !_isEarlierContextSummaryMessage(message),
  );

  if (prefixMessages.length === 0) {
    return messages;
  }

  if (unpinnedPrefixMessages.length === 0) {
    const resultWithPinnedOnly: ModelMessage[] = [firstMessage, ...pinnedSummaryMessages, ...activeSuffix];

    logger.info("Compaction stage finished", {
      stage: "prefix_before_latest_user",
      before: countTokens(messages),
      after: countTokens(resultWithPinnedOnly),
      reducedBy: countTokens(messages) - countTokens(resultWithPinnedOnly),
      prefixMessageCount: prefixMessages.length,
      pinnedSummaryCount: pinnedSummaryMessages.length,
      summarizedPrefixCount: 0,
      keptSuffixCount: activeSuffix.length,
    });

    return resultWithPinnedOnly;
  }

  const summaryBudgetTokens: number = Math.max(
    600,
    Math.floor(targetTokenCount - countTokens([firstMessage, ...pinnedSummaryMessages, ...activeSuffix]) - 180),
  );

  const summaryText: string = await _summarizeMessagesSingleShotAsync(
    unpinnedPrefixMessages,
    model,
    logger,
    summaryBudgetTokens,
  );

  const summaryMessage: ModelMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `[EARLIER CONTEXT SUMMARY - Messages before the latest user request were compacted]\n\n${summaryText}\n\n[END OF EARLIER CONTEXT SUMMARY]`,
      },
    ],
  };

  const result: ModelMessage[] = [firstMessage, ...pinnedSummaryMessages, summaryMessage, ...activeSuffix];

  logger.info("Compaction stage finished", {
    stage: "prefix_before_latest_user",
    before: countTokens(messages),
    after: countTokens(result),
    reducedBy: countTokens(messages) - countTokens(result),
    prefixMessageCount: prefixMessages.length,
    pinnedSummaryCount: pinnedSummaryMessages.length,
    summarizedPrefixCount: unpinnedPrefixMessages.length,
    keptSuffixCount: activeSuffix.length,
  });

  return result;
}

async function _compactLatestUserMessageAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): Promise<ModelMessage[]> {
  const lastUserIndex: number = _findLastUserIndex(messages);

  if (lastUserIndex < 0) {
    return messages;
  }

  const lastUserMessage: ModelMessage = messages[lastUserIndex];
  const userText: string = _extractTextContent(lastUserMessage).trim();
  if (userText.length === 0) {
    return messages;
  }

  const budgetTokens: number = Math.max(
    280,
    Math.min(1200, Math.floor(targetTokenCount * 0.08)),
  );

  const taskContractSummary: string = await _summarizeTextAsync(
    model,
    logger,
    `Convert this user request into a concise TASK CONTRACT. Preserve the critical details exactly when possible:\n` +
      `- explicit goals\n` +
      `- hard constraints and prohibitions\n` +
      `- required outputs and acceptance criteria\n` +
      `- concrete literals: URLs, IDs, file paths, numbers, cron expressions\n\n` +
      `User request:\n${userText}`,
    budgetTokens,
    "latest-user-contract",
  );

  const replacement: ModelMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `[LATEST USER REQUEST - COMPACT TASK CONTRACT]\n${taskContractSummary}\n[END OF TASK CONTRACT]`,
      },
    ],
  };

  const replacementTokens: number = countTokens([replacement]);
  const originalTokens: number = countTokens([lastUserMessage]);
  if (replacementTokens >= originalTokens) {
    logger.info("Compaction stage skipped", {
      stage: "latest_user_message",
      reason: "replacement_not_shorter",
      originalTokens,
      replacementTokens,
      lastUserIndex,
    });

    return messages;
  }

  const result: ModelMessage[] = messages.map((msg: ModelMessage, idx: number): ModelMessage =>
    idx === lastUserIndex ? replacement : msg,
  );

  logger.info("Compaction stage finished", {
    stage: "latest_user_message",
    before: countTokens(messages),
    after: countTokens(result),
    reducedBy: countTokens(messages) - countTokens(result),
    lastUserIndex,
  });

  return result;
}

async function _compactToolResultsAfterLatestUserAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): Promise<ModelMessage[]> {
  const lastUserIndex: number = _findLastUserIndex(messages);
  if (lastUserIndex < 0 || lastUserIndex >= messages.length - 1) {
    return messages;
  }

  const indexedToolMessages: Array<{ index: number; tokens: number; compactionCount: number }> = [];
  for (let i: number = lastUserIndex + 1; i < messages.length; i++) {
    const msg: ModelMessage = messages[i];
    if (msg.role !== "tool") {
      continue;
    }

    const text: string = _extractTextContent(msg);
    const tokenApprox: number = _estimateTokens(text);
    const compactionCount: number = _getToolResultCompactionCount(msg);
    indexedToolMessages.push({ index: i, tokens: tokenApprox, compactionCount });
  }

  if (indexedToolMessages.length === 0) {
    return messages;
  }

  indexedToolMessages.sort((a, b) => {
    if (a.compactionCount !== b.compactionCount) {
      return a.compactionCount - b.compactionCount;
    }

    return b.tokens - a.tokens;
  });

  const resultMessages: ModelMessage[] = [...messages];

  for (const item of indexedToolMessages) {
    if (countTokens(resultMessages) <= targetTokenCount) {
      break;
    }

    const originalMsg: ModelMessage = resultMessages[item.index];
    const originalText: string = _extractTextContent(originalMsg).trim();
    if (originalText.length < 300) {
      continue;
    }

    const summaryBudget: number = Math.max(200, Math.min(700, Math.floor(item.tokens * 0.25)));
    const summarized: string = await _summarizeTextAsync(
      model,
      logger,
      `Summarize this tool output for future continuity. Preserve:\n` +
        `- key factual result\n` +
        `- IDs / paths / URLs / codes\n` +
        `- error details if any\n\n` +
        `Tool output:\n${originalText}`,
      summaryBudget,
      `tool-output-${item.index}`,
    );

    resultMessages[item.index] = _replaceToolMessageContentWithSummary(originalMsg, summarized);
  }

  logger.info("Compaction stage finished", {
    stage: "tool_results_after_latest_user",
    before: countTokens(messages),
    after: countTokens(resultMessages),
    reducedBy: countTokens(messages) - countTokens(resultMessages),
    toolMessagesConsidered: indexedToolMessages.length,
  });

  return resultMessages;
}

function _replaceToolMessageContentWithSummary(
  originalMsg: ModelMessage,
  summarized: string,
): ModelMessage {
  const currentCompactionCount: number = _getToolResultCompactionCount(originalMsg);
  const nextCompactionCount: number = currentCompactionCount > 0 ? currentCompactionCount + 1 : 1;
  const compactedText: string =
    `[COMPACTED TOOL RESULT]\n` +
    `[COMPACTION COUNT: ${nextCompactionCount}]\n` +
    `${summarized}`;

  if (!Array.isArray(originalMsg.content)) {
    return originalMsg;
  }

  const replacementOutput: { type: "text"; value: string } = {
    type: "text",
    value: compactedText,
  };

  const newContent: unknown[] = originalMsg.content.map((part: unknown): unknown => {
    if (typeof part !== "object" || part === null) {
      return part;
    }

    const candidate: Record<string, unknown> = part as Record<string, unknown>;

    if (candidate.type === "tool-result") {
      if ("output" in candidate) {
        return {
          ...candidate,
          output: replacementOutput,
        };
      }

      if ("result" in candidate) {
        return {
          ...candidate,
          result: compactedText,
        };
      }

      return {
        ...candidate,
        output: replacementOutput,
      };
    }

    return part;
  });

  return {
    ...originalMsg,
    content: newContent as ModelMessage["content"],
  } as unknown as ModelMessage;
}

function _isEarlierContextSummaryMessage(message: ModelMessage): boolean {
  const textContent: string = _extractTextContent(message);
  return textContent.includes("[EARLIER CONTEXT SUMMARY");
}

function _getToolResultCompactionCount(message: ModelMessage): number {
  const textContent: string = _extractTextContent(message);

  if (!textContent.includes("[COMPACTED TOOL RESULT]")) {
    return 0;
  }

  const countMatch: RegExpMatchArray | null = textContent.match(/\[COMPACTION COUNT:\s*(\d+)\]/i);
  if (countMatch && countMatch[1]) {
    const parsedCount: number = Number.parseInt(countMatch[1], 10);
    if (Number.isFinite(parsedCount) && parsedCount > 0) {
      return parsedCount;
    }
  }

  return 1;
}

async function _summarizeMessagesSingleShotAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetSummaryTokens: number,
): Promise<string> {
  const sourceText: string = _messagesToPlainText(messages);

  return await _summarizeTextAsync(
    model,
    logger,
    sourceText,
    targetSummaryTokens,
    "oneshot",
  );
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
        `/no_think\n` +
        `Summarize the following conversation excerpt. ` +
        `Keep key decisions, actions, concrete facts, identifiers, and pending tasks. ` +
        `Pay special attention to [Assistant reasoning] entries — these contain the rationale ` +
        `behind decisions and tool calls. Preserve the reasoning/rationale in your summary so ` +
        `that the assistant can recall WHY it made past decisions, not just WHAT it did. ` +
        `Target length: about ${targetChars} characters. ` +
        `Do not exceed ${targetChars} characters. If needed, prefer concise bullet-like phrasing over prose.\n\n` +
        `Conversation excerpt:\n${sourceText}`,
      retryOptions: { callType: "summarization" },
    });

    return result.text && result.text.trim().length > 0
      ? result.text.trim()
      : `[Summary unavailable for phase ${phase}]`;
  } catch (error: unknown) {
    logger.warn("History compaction: partial summary failed", {
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
        args?: Record<string, unknown>;
        input?: Record<string, unknown>;
      };
      const args: Record<string, unknown> = (toolCall.args ?? toolCall.input ?? {}) as Record<string, unknown>;

      // Extract reasoning prominently so the summarization LLM can see it
      if (args.reasoning && typeof args.reasoning === "string") {
        parts.push(`[Assistant reasoning]: "${args.reasoning}"`);
        const { reasoning: _ignored, ...remainingArgs } = args;
        parts.push(`[Tool call]: ${toolCall.toolName ?? "unknown"}(${JSON.stringify(remainingArgs)})`);
      } else {
        parts.push(`[Tool call]: ${toolCall.toolName ?? "unknown"}(${JSON.stringify(args)})`);
      }
      continue;
    }

    if ("result" in part || "output" in part) {
      const resPart = part as {
        toolCallId?: string;
        toolName?: string;
        result?: unknown;
        output?: unknown;
        isError?: boolean;
      };
      const resultValue: unknown = resPart.result ?? resPart.output;
      const errorPrefix: string = resPart.isError ? " (ERROR)" : "";
      const toolLabel: string = resPart.toolName ? ` ${resPart.toolName}` : "";
      parts.push(`[Tool result${toolLabel}${errorPrefix}]: ${typeof resultValue === "string" ? resultValue : JSON.stringify(resultValue)}`);
    }
  }

  return parts.join(" ");
}

function _estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

//#endregion Private functions
