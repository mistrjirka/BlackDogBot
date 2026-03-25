import type { LanguageModel, ModelMessage } from "ai";

import { LoggerService } from "../services/logger.service.js";
import { generateTextWithRetryAsync } from "./llm-retry.js";

//#region Constants

const MAX_DAG_ITERATIONS: number = 12;
const TRUNCATED_TOOL_MAX_CHARS: number = 1800;
const CROPPED_MESSAGE_HEAD_CHARS: number = 700;
const CROPPED_MESSAGE_TAIL_CHARS: number = 260;

//#endregion Constants

//#region Interfaces

export interface ISummarizationResult {
  messages: ModelMessage[];
  passes: number;
  originalTokens: number;
  compactedTokens: number;
  converged: boolean;
  dagPath?: string[];
  dagNodeVisitCounts?: Record<string, number>;
  dagTerminationReason?: string;
  maxLevelReached?: string;
}

type TCompactionNode = "L1" | "L2" | "L3" | "L4";

interface ICompactionDagResult {
  messages: ModelMessage[];
  converged: boolean;
  passes: number;
  dagPath: TCompactionNode[];
  dagNodeVisitCounts: Record<TCompactionNode, number>;
  dagTerminationReason: string;
  maxLevelReached: TCompactionNode;
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

  if (!forced && originalTokens <= targetTokenCount) {
    return {
      messages,
      passes: 0,
      originalTokens,
      compactedTokens: originalTokens,
      converged: true,
      dagPath: [],
      dagNodeVisitCounts: {},
      dagTerminationReason: "already_within_target",
      maxLevelReached: "L1",
    };
  }

  const dagResult: ICompactionDagResult = await _compactViaDagAsync(
    messages,
    model,
    logger,
    targetTokenCount,
    countTokens,
    forced,
  );

  const compactedTokens: number = countTokens(dagResult.messages);

  logger.info("Summary-only compaction complete", {
    originalTokens,
    compactedTokens,
    passes: dagResult.passes,
    converged: dagResult.converged,
    dagPath: dagResult.dagPath,
    dagTerminationReason: dagResult.dagTerminationReason,
    maxLevelReached: dagResult.maxLevelReached,
  });

  return {
    messages: dagResult.messages,
    passes: dagResult.passes,
    originalTokens,
    compactedTokens,
    converged: dagResult.converged,
    dagPath: dagResult.dagPath,
    dagNodeVisitCounts: dagResult.dagNodeVisitCounts,
    dagTerminationReason: dagResult.dagTerminationReason,
    maxLevelReached: dagResult.maxLevelReached,
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

async function _compactViaDagAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
  forced: boolean,
): Promise<ICompactionDagResult> {
  let currentMessages: ModelMessage[] = messages;
  let node: TCompactionNode = messages.length <= 2 ? "L2" : "L1";
  let phase: "initial" | "after_l2" | "after_l3" = "initial";
  let iterations: number = 0;
  let l1Passes: number = 0;

  const dagPath: TCompactionNode[] = [];
  const dagNodeVisitCounts: Record<TCompactionNode, number> = {
    L1: 0,
    L2: 0,
    L3: 0,
    L4: 0,
  };
  let maxLevelReached: TCompactionNode = node;

  while (iterations < MAX_DAG_ITERATIONS) {
    iterations++;

    const beforeTokens: number = countTokens(currentMessages);
    const mustRunForcedCompaction: boolean = forced && iterations === 1;
    if (!mustRunForcedCompaction && beforeTokens <= targetTokenCount) {
      return {
        messages: currentMessages,
        converged: true,
        passes: l1Passes,
        dagPath,
        dagNodeVisitCounts,
        dagTerminationReason: "reached_target_before_node",
        maxLevelReached,
      };
    }

    dagPath.push(node);
    dagNodeVisitCounts[node]++;

    if (node === "L1") {
      l1Passes++;
    }

    const beforeMessages: ModelMessage[] = currentMessages;
    let nextMessages: ModelMessage[] = currentMessages;

    if (node === "L1") {
      nextMessages = await _compactSinglePassAsync(
        currentMessages,
        model,
        logger,
        targetTokenCount,
        countTokens,
      );
    } else if (node === "L2") {
      nextMessages = await _compactToolResultsIndividuallyAsync(
        currentMessages,
        model,
        logger,
        targetTokenCount,
        countTokens,
      );
    } else if (node === "L3") {
      nextMessages = _truncateToolResultsAsync(currentMessages, targetTokenCount, countTokens);
    } else {
      nextMessages = _cropMessagesFallbackAsync(currentMessages, targetTokenCount, countTokens);
    }

    currentMessages = nextMessages;
    const afterTokens: number = countTokens(currentMessages);
    const improved: boolean = afterTokens < beforeTokens || JSON.stringify(beforeMessages) !== JSON.stringify(currentMessages);

    logger.info("Compaction DAG node completed", {
      node,
      phase,
      beforeTokens,
      afterTokens,
      reducedBy: beforeTokens - afterTokens,
      improved,
      iteration: iterations,
      targetTokenCount,
    });

    if (afterTokens <= targetTokenCount) {
      return {
        messages: currentMessages,
        converged: true,
        passes: l1Passes,
        dagPath,
        dagNodeVisitCounts,
        dagTerminationReason: "reached_target_after_node",
        maxLevelReached,
      };
    }

    if (node === "L4") {
      return {
        messages: currentMessages,
        converged: false,
        passes: l1Passes,
        dagPath,
        dagNodeVisitCounts,
        dagTerminationReason: "reached_terminal_l4_without_target",
        maxLevelReached,
      };
    }

    if (node === "L1") {
      if (phase === "initial") {
        node = "L2";
      } else if (phase === "after_l2") {
        node = "L3";
      } else {
        node = "L4";
      }
      maxLevelReached = _maxLevel(maxLevelReached, node);
      continue;
    }

    if (node === "L2") {
      if (improved) {
        phase = "after_l2";
        node = "L1";
      } else {
        node = "L4";
      }
      maxLevelReached = _maxLevel(maxLevelReached, node);
      continue;
    }

    if (node === "L3") {
      if (improved) {
        phase = "after_l3";
        node = "L1";
      } else {
        node = "L4";
      }
      maxLevelReached = _maxLevel(maxLevelReached, node);
      continue;
    }
  }

  return {
    messages: currentMessages,
    converged: false,
    passes: l1Passes,
    dagPath,
    dagNodeVisitCounts,
    dagTerminationReason: "max_dag_iterations_reached",
    maxLevelReached,
  };
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

async function _compactToolResultsIndividuallyAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): Promise<ModelMessage[]> {
  const lastUserIndex: number = _findLastUserIndex(messages);
  const indexedToolMessages: Array<{ index: number; tokens: number; compactionCount: number }> = [];

  for (let i: number = 0; i < messages.length; i++) {
    if (messages[i].role !== "tool") {
      continue;
    }

    if (lastUserIndex >= 0 && i <= lastUserIndex && messages.length > 2) {
      continue;
    }

    const text: string = _extractTextContent(messages[i]);
    indexedToolMessages.push({
      index: i,
      tokens: _estimateTokens(text),
      compactionCount: _getToolResultCompactionCount(messages[i]),
    });
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

    const originalMessage: ModelMessage = resultMessages[item.index];
    const originalText: string = _extractTextContent(originalMessage).trim();
    if (originalText.length < 300) {
      continue;
    }

    const summaryBudget: number = Math.max(220, Math.min(900, Math.floor(item.tokens * 0.35)));
    const summarized: string = await _summarizeTextAsync(
      model,
      logger,
      `Per-tool DAG compaction output. Preserve IDs, URLs, paths, errors, and final outcome.\n\n` +
        `Tool output:\n${originalText}`,
      summaryBudget,
      `dag-per-tool-${item.index}`,
    );

    resultMessages[item.index] = _replaceToolMessageContentWithSummary(originalMessage, summarized);
  }

  logger.info("Compaction stage finished", {
    stage: "dag_tool_results_individual",
    before: countTokens(messages),
    after: countTokens(resultMessages),
    reducedBy: countTokens(messages) - countTokens(resultMessages),
    toolMessagesConsidered: indexedToolMessages.length,
  });

  return resultMessages;
}

function _truncateToolResultsAsync(
  messages: ModelMessage[],
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): ModelMessage[] {
  const indexedTools: Array<{ index: number; chars: number }> = [];

  for (let i: number = 0; i < messages.length; i++) {
    if (messages[i].role !== "tool") {
      continue;
    }

    const text: string = _extractTextContent(messages[i]);
    indexedTools.push({ index: i, chars: text.length });
  }

  indexedTools.sort((a, b) => b.chars - a.chars);
  const resultMessages: ModelMessage[] = [...messages];

  for (const item of indexedTools) {
    if (countTokens(resultMessages) <= targetTokenCount) {
      break;
    }

    const originalMessage: ModelMessage = resultMessages[item.index];
    const originalText: string = _extractTextContent(originalMessage);
    if (originalText.length <= TRUNCATED_TOOL_MAX_CHARS) {
      continue;
    }

    const truncatedText: string =
      `[TRUNCATED TOOL RESULT]\n` +
      `[ORIGINAL LENGTH: ${originalText.length}]\n` +
      `${originalText.slice(0, TRUNCATED_TOOL_MAX_CHARS)}`;

    resultMessages[item.index] = _replaceToolMessageContentWithSummary(originalMessage, truncatedText);
  }

  return resultMessages;
}

function _cropMessagesFallbackAsync(
  messages: ModelMessage[],
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): ModelMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  let resultMessages: ModelMessage[] = messages;

  if (messages.length > 4) {
    const first: ModelMessage = messages[0];
    const tail: ModelMessage[] = messages.slice(-3);
    resultMessages = [first, ...tail];
  }

  if (countTokens(resultMessages) <= targetTokenCount) {
    return resultMessages;
  }

  const cropped: ModelMessage[] = resultMessages.map((message: ModelMessage, index: number): ModelMessage => {
    if (index === 0) {
      return message;
    }

    const fullText: string = _extractTextContent(message);
    if (fullText.length <= CROPPED_MESSAGE_HEAD_CHARS + CROPPED_MESSAGE_TAIL_CHARS + 30) {
      return message;
    }

    const croppedText: string =
      `${fullText.slice(0, CROPPED_MESSAGE_HEAD_CHARS)}\n` +
      `[... CROPPED FOR CONTEXT BUDGET ...]\n` +
      `${fullText.slice(-CROPPED_MESSAGE_TAIL_CHARS)}`;

    if (message.role === "tool") {
      return _replaceToolMessageContentWithSummary(message, croppedText);
    }

    return {
      ...message,
      content: croppedText,
    } as ModelMessage;
  });

  return cropped;
}

function _maxLevel(current: TCompactionNode, next: TCompactionNode): TCompactionNode {
  const level: Record<TCompactionNode, number> = {
    L1: 1,
    L2: 2,
    L3: 3,
    L4: 4,
  };

  return level[next] > level[current] ? next : current;
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
