import type { LanguageModel, ModelMessage } from "ai";

import { LoggerService } from "../services/logger.service.js";
import { generateTextWithRetryAsync } from "./llm-retry.js";

//#region Constants

const MAX_SUMMARIZATION_PASSES: number = 1;

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

  const firstMessage: ModelMessage = messages[0];
  const keepRecentCount: number = _getKeepRecentCount(messages, countTokens);
  const recentMessages: ModelMessage[] = messages.slice(-keepRecentCount);
  const oldMessages: ModelMessage[] = messages.slice(1, -keepRecentCount);

  if (oldMessages.length === 0) {
    return messages;
  }

  const summaryBudgetTokens: number = Math.max(
    700,
    Math.floor(targetTokenCount - countTokens([firstMessage, ...recentMessages]) - 180),
  );

  const summaryText: string = await _summarizeMessagesSingleShotAsync(
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

/**
 * Determines how many recent messages to keep based on a dynamic token budget.
 * Walks backwards from the end of the message array, accumulating token counts,
 * and keeps messages as long as the total stays under 15% of the total message
 * token count. Minimum 2 messages are always kept.
 */
function _getKeepRecentCount(
  messages: ModelMessage[],
  countTokens: (msgs: ModelMessage[]) => number,
): number {
  const minKeep: number = 2;

  if (messages.length <= minKeep + 1) {
    return Math.max(1, messages.length - 1);
  }

  // Total tokens across all messages (excluding the first / system message)
  const allNonFirstMessages: ModelMessage[] = messages.slice(1);
  const totalTokens: number = countTokens(allNonFirstMessages);
  const budget: number = Math.floor(totalTokens * 0.15);

  let kept: number = 0;
  let accumulated: number = 0;

  for (let i: number = messages.length - 1; i >= 1; i--) {
    const msgTokens: number = countTokens([messages[i]]);

    if (kept >= minKeep && accumulated + msgTokens > budget) {
      break;
    }

    accumulated += msgTokens;
    kept++;

    // If we've already consumed the budget and met the minimum, stop
    if (kept >= minKeep && accumulated >= budget) {
      break;
    }
  }

  return Math.max(minKeep, kept);
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
        `Target length: about ${targetChars} characters.\n\n` +
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
