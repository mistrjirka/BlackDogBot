import type { LanguageModel, ModelMessage } from "ai";

import { LoggerService } from "../services/logger.service.js";
import { generateTextWithRetryAsync } from "./llm-retry.js";
import { isContextExceededApiError } from "./context-error.js";

//#region Constants

const MAX_DAG_ITERATIONS: number = 12;

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

type TCompactionNode = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";

interface ICompactionDagResult {
  messages: ModelMessage[];
  converged: boolean;
  passes: number;
  dagPath: TCompactionNode[];
  dagNodeVisitCounts: Record<TCompactionNode, number>;
  dagTerminationReason: string;
  maxLevelReached: TCompactionNode;
}

interface ICompactionOptions {
  contextWindow?: number;
  latestUserCompactionMinContextRatio?: number;
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
  options: ICompactionOptions = {},
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
    options,
  );

  let finalDagResult: ICompactionDagResult = dagResult;
  if (!dagResult.converged) {
    logger.warn("DAG did not converge, applying multimodal fallback ladder (L5/L6/L7)", {
      dagPath: dagResult.dagPath,
      dagTerminationReason: dagResult.dagTerminationReason,
      maxLevelReached: dagResult.maxLevelReached,
    });
    finalDagResult = _applyMultimodalFallbackLadder(
      dagResult,
      logger,
      targetTokenCount,
      countTokens,
    );
  }

  const compactedTokens: number = countTokens(finalDagResult.messages);

  logger.info("Summary-only compaction complete", {
    originalTokens,
    compactedTokens,
    passes: finalDagResult.passes,
    converged: finalDagResult.converged,
    dagPath: finalDagResult.dagPath,
    dagTerminationReason: finalDagResult.dagTerminationReason,
    maxLevelReached: finalDagResult.maxLevelReached,
  });

  return {
    messages: finalDagResult.messages,
    passes: finalDagResult.passes,
    originalTokens,
    compactedTokens,
    converged: finalDagResult.converged,
    dagPath: finalDagResult.dagPath,
    dagNodeVisitCounts: finalDagResult.dagNodeVisitCounts,
    dagTerminationReason: finalDagResult.dagTerminationReason,
    maxLevelReached: finalDagResult.maxLevelReached,
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
  options: ICompactionOptions,
): Promise<ModelMessage[]> {
  if (messages.length <= 2) {
    return messages;
  }

  let currentResult: ModelMessage[] = messages;

  // Stage A: compact prefix before last user
  try {
    const stageAResult: ModelMessage[] = await _compactPrefixBeforeLastUserAsync(
      currentResult,
      model,
      logger,
      targetTokenCount,
      countTokens,
      options,
    );
    currentResult = stageAResult;
  } catch (error: unknown) {
    logger.warn("L1 Stage A (prefix compaction) failed, continuing to Stage B", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (countTokens(currentResult) <= targetTokenCount) {
    return currentResult;
  }

  // Stage B: compact latest user message
  try {
    const stageBResult: ModelMessage[] = await _compactLatestUserMessageAsync(
      currentResult,
      model,
      logger,
      targetTokenCount,
      countTokens,
      options,
    );
    currentResult = stageBResult;
  } catch (error: unknown) {
    logger.warn("L1 Stage B (latest user compaction) failed, continuing to Stage C", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (countTokens(currentResult) <= targetTokenCount) {
    return currentResult;
  }

  // Stage C: compact tool results after latest user
  try {
    const stageCResult: ModelMessage[] = await _compactToolResultsAfterLatestUserAsync(
      currentResult,
      model,
      logger,
      targetTokenCount,
      countTokens,
    );
    currentResult = stageCResult;
  } catch (error: unknown) {
    logger.warn("L1 Stage C (tool results compaction) failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return currentResult;
}

async function _compactViaDagAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
  forced: boolean,
  options: ICompactionOptions,
): Promise<ICompactionDagResult> {
  let currentMessages: ModelMessage[] = messages;
  let node: TCompactionNode = messages.length <= 2 ? "L2" : "L1";
  let phase: "initial" | "after_l2" | "after_l3" = "initial";
  let iterations: number = 0;
  let l1Passes: number = 0;
  let consecutiveFailures: number = 0; // circuit breaker: skip LLM nodes after 2 consecutive failures

  const dagPath: TCompactionNode[] = [];
  const dagNodeVisitCounts: Record<TCompactionNode, number> = {
    L1: 0,
    L2: 0,
    L3: 0,
    L4: 0,
    L5: 0,
    L6: 0,
    L7: 0,
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

    try {
      if (node === "L1") {
        nextMessages = await _compactSinglePassAsync(
          currentMessages,
          model,
          logger,
          targetTokenCount,
          countTokens,
          options,
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
        nextMessages = await _compactBatchedMessagesAsync(
          currentMessages,
          model,
          logger,
          targetTokenCount,
          countTokens,
          false, // not aggressive
        );
      } else {
        nextMessages = await _compactBatchedMessagesAsync(
          currentMessages,
          model,
          logger,
          targetTokenCount,
          countTokens,
          true, // aggressive
        );
      }
    } catch (error: unknown) {
      consecutiveFailures++;
      const isContextError: boolean = isContextExceededApiError(error);
      logger.warn("DAG node failed, treating as no improvement", {
        node,
        phase,
        iteration: iterations,
        consecutiveFailures,
        isContextExceeded: isContextError,
        error: error instanceof Error ? error.message : String(error),
      });
      // Treat as "no improvement" — nextMessages stays equal to beforeMessages
      // The existing improved check will route to the next DAG node
      nextMessages = beforeMessages;

      // Circuit breaker: after 2 consecutive LLM failures, skip to fallback ladder
      if (consecutiveFailures >= 2) {
        logger.warn("Circuit breaker: 2 consecutive DAG node failures, skipping to fallback ladder", {
          dagPath,
          consecutiveFailures,
        });
        break;
      }
    }

    currentMessages = nextMessages;
    const afterTokens: number = countTokens(currentMessages);
    const improved: boolean = afterTokens < beforeTokens || JSON.stringify(beforeMessages) !== JSON.stringify(currentMessages);

    // Reset circuit breaker on success
    if (improved) {
      consecutiveFailures = 0;
    }

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
        node = "L3";
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
  options: ICompactionOptions = {},
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

  // Chunked multi-pass summarization to avoid exceeding hard gate
  // Use prompt-based token estimation (60% of context window) instead of structured countTokens
  const contextWindow: number = options.contextWindow ?? 128_000;
  const maxChunkPromptTokens: number = Math.floor(contextWindow * 0.60); // 60% of context window, 25% headroom below hard gate

  // Create a token counter that estimates actual prompt tokens (including instruction template)
  // Used for the initial "fits in one chunk" check
  const promptTokenCounter = (msgs: ModelMessage[]): number => {
    const promptText: string = _messagesToPlainText(msgs);
    return countTokens([{ role: "user", content: _buildSummarizationPrompt(promptText, summaryBudgetTokens) } as ModelMessage]);
  };

  // Create a lightweight counter for chunking that only counts plain text tokens
  // This avoids overcounting by including the instruction template N times for N messages
  const plainTextTokenCounter = (msgs: ModelMessage[]): number => {
    const plainText: string = _messagesToPlainText(msgs);
    return countTokens([{ role: "user", content: plainText } as ModelMessage]);
  };

  // Estimate prompt tokens for the full unpinned prefix
  const fullPrefixEstimatedTokens: number = promptTokenCounter(unpinnedPrefixMessages);

  let chunks: ModelMessage[][];
  if (fullPrefixEstimatedTokens <= maxChunkPromptTokens) {
    // Fits in one chunk - no splitting needed
    chunks = [unpinnedPrefixMessages];
  } else {
    // Split into chunks using plain text token counter (avoids overcounting)
    chunks = _splitMessagesIntoChunks(unpinnedPrefixMessages, maxChunkPromptTokens, plainTextTokenCounter);
  }

  const summaryText: string = await _summarizePrefixChunksAsync(chunks, model, logger, summaryBudgetTokens, countTokens);

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
  options: ICompactionOptions,
): Promise<ModelMessage[]> {
  const lastUserIndex: number = _findLastUserIndex(messages);

  if (lastUserIndex < 0) {
    return messages;
  }

  const lastUserMessage: ModelMessage = messages[lastUserIndex];
  const originalTokens: number = countTokens([lastUserMessage]);
  const contextWindow: number | undefined = options.contextWindow;
  const minContextRatio: number = options.latestUserCompactionMinContextRatio ?? 0.10;
  const hasValidContextWindow: boolean =
    typeof contextWindow === "number"
    && Number.isFinite(contextWindow)
    && contextWindow > 0;
  const hasValidRatio: boolean = Number.isFinite(minContextRatio) && minContextRatio > 0 && minContextRatio <= 1;

  if (hasValidContextWindow && hasValidRatio) {
    const normalizedContextWindow: number = contextWindow as number;
    const minRequiredTokens: number = Math.ceil(normalizedContextWindow * minContextRatio);
    if (originalTokens < minRequiredTokens) {
      logger.info("Compaction stage skipped", {
        stage: "latest_user_message",
        reason: "below_context_ratio_threshold",
        originalTokens,
        minRequiredTokens,
        contextWindow: normalizedContextWindow,
        minContextRatio,
        lastUserIndex,
      });

      return messages;
    }
  }

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

  indexedToolMessages.sort(_sortToolMessagesByCompactionAndTokens);

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
    try {
      const summarized: string = await _summarizeTextAsync(
        model,
        `Summarize this tool output for future continuity. Preserve:\n` +
          `- key factual result\n` +
          `- IDs / paths / URLs / codes\n` +
          `- error details if any\n\n` +
          `Tool output:\n${originalText}`,
        summaryBudget,
        `tool-output-${item.index}`,
      );

      resultMessages[item.index] = _replaceToolMessageContentWithSummary(originalMsg, summarized);
    } catch (error: unknown) {
      logger.warn("L1-C per-tool summarization failed, skipping this tool", {
        toolIndex: item.index,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  indexedToolMessages.sort(_sortToolMessagesByCompactionAndTokens);

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
    try {
      const summarized: string = await _summarizeTextAsync(
        model,
        `Per-tool DAG compaction output. Preserve IDs, URLs, paths, errors, and final outcome.\n\n` +
          `Tool output:\n${originalText}`,
        summaryBudget,
        `dag-per-tool-${item.index}`,
      );

      resultMessages[item.index] = _replaceToolMessageContentWithSummary(originalMessage, summarized);
    } catch (error: unknown) {
      logger.warn("L2 per-tool summarization failed, skipping this tool", {
        toolIndex: item.index,
        error: error instanceof Error ? error.message : String(error),
      });
      // Skip this tool, continue with next
    }
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

async function _compactBatchedMessagesAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
  aggressive: boolean,
): Promise<ModelMessage[]> {
  const lastUserIndex: number = _findLastUserIndex(messages);
  const summaryBudget: number = aggressive ? 150 : 400;
  const batchSize: number = 8; // up to 8 messages per batch

  // Collect candidate messages (skip system, latest user, already-compacted, short messages)
  const candidates: Array<{ index: number; text: string }> = [];
  for (let i: number = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    if (i === lastUserIndex) continue;
    if (_isEarlierContextSummaryMessage(msg)) continue;
    if (_getToolResultCompactionCount(msg) > 0) continue; // already compacted tool result

    const text: string = _extractTextContent(msg).trim();
    if (text.length < 200) continue;

    candidates.push({ index: i, text });
  }

  if (candidates.length === 0) {
    return messages;
  }

  // Track which indices to keep and which to replace
  const keepIndices: Set<number> = new Set();
  for (let i: number = 0; i < messages.length; i++) {
    keepIndices.add(i);
  }
  const replacements: Map<number, ModelMessage> = new Map();

  // Maintain running token count to avoid O(N*B) full rebuilds
  let runningTokenCount: number = countTokens(messages);

  // Group candidates into batches of adjacent messages
  let batchStart: number = 0;
  while (batchStart < candidates.length) {
    if (runningTokenCount <= targetTokenCount) {
      break;
    }

    const batchEnd: number = Math.min(batchStart + batchSize, candidates.length);
    const batch: typeof candidates = candidates.slice(batchStart, batchEnd);

    // Combine batch messages into a single text for summarization (use original messages)
    const batchMessages: ModelMessage[] = batch.map((c: { index: number; text: string }): ModelMessage => messages[c.index]);
    const batchText: string = _messagesToPlainText(batchMessages);

    try {
      const summarized: string = await _summarizeTextAsync(
        model,
        `Summarize these conversation messages concisely. Preserve key facts, decisions, IDs, and outcomes.\n\n${batchText}`,
        summaryBudget,
        `batch-${batchStart}`,
      );

      // Replace the first message in the batch with the summary, mark the rest for removal
      const firstIndex: number = batch[0].index;
      const replacementMsg: ModelMessage = {
        role: "user",
        content: `[COMPACTED BATCH (${batch.length} messages)]\n${summarized}`,
      };
      replacements.set(firstIndex, replacementMsg);

      // Update running token count: subtract original batch messages, add replacement
      const originalFirstTokens: number = countTokens([messages[firstIndex]]);
      const replacementTokens: number = countTokens([replacementMsg]);
      runningTokenCount += replacementTokens - originalFirstTokens;
      for (let i: number = 1; i < batch.length; i++) {
        const removedTokens: number = countTokens([messages[batch[i].index]]);
        runningTokenCount -= removedTokens;
        keepIndices.delete(batch[i].index);
      }
    } catch (error: unknown) {
      logger.warn("L3/L4 batch summarization failed, skipping this batch", {
        batchStart,
        batchSize: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    batchStart = batchEnd;
  }

  // Build final result from kept indices and replacements
  const resultMessages: ModelMessage[] = [];
  for (let i: number = 0; i < messages.length; i++) {
    if (!keepIndices.has(i)) continue;
    resultMessages.push(replacements.get(i) ?? messages[i]);
  }

  logger.info("Compaction stage finished", {
    stage: aggressive ? "aggressive_batched" : "batched",
    before: countTokens(messages),
    after: countTokens(resultMessages),
    reducedBy: countTokens(messages) - countTokens(resultMessages),
    candidatesConsidered: candidates.length,
  });

  return resultMessages;
}

function _maxLevel(current: TCompactionNode, next: TCompactionNode): TCompactionNode {
  const level: Record<TCompactionNode, number> = {
    L1: 1,
    L2: 2,
    L3: 3,
    L4: 4,
    L5: 5,
    L6: 6,
    L7: 7,
  };

  return level[next] > level[current] ? next : current;
}

function _applyMultimodalFallbackLadder(
  dagResult: ICompactionDagResult,
  logger: LoggerService,
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): ICompactionDagResult {
  let messages: ModelMessage[] = dagResult.messages;
  const dagPath: TCompactionNode[] = [...dagResult.dagPath];
  const dagNodeVisitCounts: Record<TCompactionNode, number> = {
    ...dagResult.dagNodeVisitCounts,
  };
  let maxLevelReached: TCompactionNode = dagResult.maxLevelReached;

  dagPath.push("L5");
  dagNodeVisitCounts.L5++;
  maxLevelReached = _maxLevel(maxLevelReached, "L5");

  const beforeL5: number = countTokens(messages);
  messages = _dropOldestNonSystemMessages(messages, targetTokenCount, countTokens);
  const afterL5: number = countTokens(messages);
  if (afterL5 < beforeL5) {
    logger.warn("Multimodal fallback L5 applied (drop oldest non-system messages)", {
      before: beforeL5,
      after: afterL5,
      reducedBy: beforeL5 - afterL5,
      targetTokenCount,
    });
  }
  if (afterL5 <= targetTokenCount) {
    return {
      ...dagResult,
      messages,
      converged: true,
      dagPath,
      dagNodeVisitCounts,
      dagTerminationReason: "reached_target_after_l5",
      maxLevelReached,
    };
  }

  dagPath.push("L6");
  dagNodeVisitCounts.L6++;
  maxLevelReached = _maxLevel(maxLevelReached, "L6");

  const beforeL6: number = countTokens(messages);
  messages = _pruneIntermediateToolResults(messages, targetTokenCount, countTokens);
  const afterL6: number = countTokens(messages);
  if (afterL6 < beforeL6) {
    logger.warn("Multimodal fallback L6 applied (prune intermediate tool results)", {
      before: beforeL6,
      after: afterL6,
      reducedBy: beforeL6 - afterL6,
      targetTokenCount,
    });
  }
  if (afterL6 <= targetTokenCount) {
    return {
      ...dagResult,
      messages,
      converged: true,
      dagPath,
      dagNodeVisitCounts,
      dagTerminationReason: "reached_target_after_l6",
      maxLevelReached,
    };
  }

  if (_messagesContainImages(messages)) {
    dagPath.push("L7");
    dagNodeVisitCounts.L7++;
    maxLevelReached = _maxLevel(maxLevelReached, "L7");

    const beforeL7: number = countTokens(messages);
    const beforeL7Messages: ModelMessage[] = [...messages];
    messages = _dropImagesFromNonLatestUser(messages);
    const afterL7: number = countTokens(messages);

    if (afterL7 < beforeL7 || JSON.stringify(messages) !== JSON.stringify(beforeL7Messages)) {
      logger.warn("Multimodal fallback L7 applied (drop non-latest user images)", {
        before: beforeL7,
        after: afterL7,
        reducedBy: beforeL7 - afterL7,
        targetTokenCount,
      });
    }

    if (afterL7 <= targetTokenCount) {
      return {
        ...dagResult,
        messages,
        converged: true,
        dagPath,
        dagNodeVisitCounts,
        dagTerminationReason: "reached_target_after_l7",
        maxLevelReached,
      };
    }
  }

  return {
    ...dagResult,
    messages,
    converged: false,
    dagPath,
    dagNodeVisitCounts,
    dagTerminationReason: "fallback_ladder_exhausted",
    maxLevelReached,
  };
}

function _dropOldestNonSystemMessages(
  messages: ModelMessage[],
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): ModelMessage[] {
  let result: ModelMessage[] = [...messages];

  while (result.length > 4 && countTokens(result) > targetTokenCount) {
    const latestUserIndex: number = _findLastUserIndex(result);
    let removeIndex: number = -1;
    for (let i: number = 1; i < result.length - 2; i++) {
      if (i === latestUserIndex) {
        continue;
      }

      removeIndex = i;
      break;
    }

    if (removeIndex < 0) {
      break;
    }

    result = [...result.slice(0, removeIndex), ...result.slice(removeIndex + 1)];
  }

  return result;
}

function _pruneIntermediateToolResults(
  messages: ModelMessage[],
  targetTokenCount: number,
  countTokens: (msgs: ModelMessage[]) => number,
): ModelMessage[] {
  const toolIndexes: number[] = [];
  for (let i: number = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      toolIndexes.push(i);
    }
  }

  if (toolIndexes.length <= 2) {
    return messages;
  }

  const keepIndexes: Set<number> = new Set(toolIndexes.slice(-2));
  let result: ModelMessage[] = [...messages];

  for (let i: number = 0; i < messages.length; i++) {
    if (countTokens(result) <= targetTokenCount) {
      break;
    }

    if (messages[i].role !== "tool" || keepIndexes.has(i)) {
      continue;
    }

    const currentIndexInResult: number = result.indexOf(messages[i]);
    if (currentIndexInResult < 0) {
      continue;
    }

    result = [...result.slice(0, currentIndexInResult), ...result.slice(currentIndexInResult + 1)];
  }

  return result;
}

function _messagesContainImages(messages: ModelMessage[]): boolean {
  return messages.some((message: ModelMessage): boolean => {
    if (!Array.isArray(message.content)) {
      return false;
    }

    return message.content.some((part: unknown): boolean => {
      if (typeof part !== "object" || part === null || !("type" in part)) {
        return false;
      }

      return (part as { type?: string }).type === "image";
    });
  });
}

function _dropImagesFromNonLatestUser(messages: ModelMessage[]): ModelMessage[] {
  const latestUserIndex: number = _findLastUserIndex(messages);

  return messages.map((message: ModelMessage, index: number): ModelMessage => {
    if (message.role !== "user" || !Array.isArray(message.content) || index === latestUserIndex) {
      return message;
    }

    const nonImageParts: unknown[] = message.content.filter((part: unknown): boolean => {
      if (typeof part !== "object" || part === null || !("type" in part)) {
        return true;
      }

      return (part as { type?: string }).type !== "image";
    });

    if (nonImageParts.length > 0) {
      const remainingTextParts: string[] = nonImageParts
        .map((part: unknown): string => {
          if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
          }

          return "";
        })
        .filter((text: string): boolean => text.trim().length > 0);

      if (remainingTextParts.length > 0) {
        return {
          ...message,
          content: remainingTextParts.join(" "),
        } as ModelMessage;
      }
    }

    return {
      ...message,
      content: "[IMAGE REMOVED FOR CONTEXT BUDGET]",
    } as ModelMessage;
  });
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

  const replacementOutput: { type: "text"; text: string } = {
    type: "text",
    text: compactedText,
  };

  const newContent = originalMsg.content.map((part: unknown): unknown => {
    if (typeof part !== "object" || part === null) {
      return part;
    }

    const candidate: Record<string, unknown> = part as Record<string, unknown>;

    if (candidate.type === "tool-result") {
      // Align write-preference with read-preference: _extractTextContent reads `result ?? output`
      if ("result" in candidate) {
        return {
          ...candidate,
          result: compactedText,
        };
      }

      if ("output" in candidate) {
        return {
          ...candidate,
          output: replacementOutput,
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
    content: newContent as typeof originalMsg.content,
  } as ModelMessage;
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

interface IIndexedToolMessage {
  index: number;
  tokens: number;
  compactionCount: number;
}

function _sortToolMessagesByCompactionAndTokens(a: IIndexedToolMessage, b: IIndexedToolMessage): number {
  if (a.compactionCount !== b.compactionCount) {
    return a.compactionCount - b.compactionCount;
  }

  return b.tokens - a.tokens;
}

async function _summarizeMessagesSingleShotAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  targetSummaryTokens: number,
): Promise<string> {
  const sourceText: string = _messagesToPlainText(messages);

  return await _summarizeTextAsync(
    model,
    sourceText,
    targetSummaryTokens,
    "oneshot",
  );
}

async function _summarizePrefixChunksAsync(
  chunks: ModelMessage[][],
  model: LanguageModel,
  logger: LoggerService,
  summaryBudgetTokens: number,
  countTokens: (msgs: ModelMessage[]) => number,
): Promise<string> {
  if (chunks.length === 1) {
    // Single chunk — use existing single-shot summarization
    return await _summarizeMessagesSingleShotAsync(
      chunks[0],
      model,
      summaryBudgetTokens,
    );
  }

  // Multiple chunks — summarize each, then combine
  logger.info("L1 chunked prefix summarization", {
    chunkCount: chunks.length,
    chunkSizes: chunks.map((c: ModelMessage[]): number => countTokens(c)),
  });

  const chunkSummaries: string[] = [];
  const perChunkBudget: number = Math.max(400, Math.floor(summaryBudgetTokens / chunks.length));

  for (let i: number = 0; i < chunks.length; i++) {
    const chunkSummary: string = await _summarizeMessagesSingleShotAsync(
      chunks[i],
      model,
      perChunkBudget,
    );
    chunkSummaries.push(chunkSummary);
  }

  // Combine chunk summaries into one coherent summary
  const combinedText: string = chunkSummaries
    .map((s: string, i: number): string => `[Chunk ${i + 1}]:\n${s}`)
    .join("\n\n");

  return await _summarizeTextAsync(
    model,
    `Combine these conversation summaries into one coherent summary. Preserve key decisions, actions, concrete facts, identifiers, and pending tasks.\n\n${combinedText}`,
    summaryBudgetTokens,
    "combine-chunks",
  );
}

function _buildSummarizationPrompt(sourceText: string, targetTokens: number): string {
  const targetChars: number = Math.max(300, targetTokens * 4);
  return (
    `/no_think\n` +
    `Summarize the following conversation excerpt. ` +
    `Keep key decisions, actions, concrete facts, identifiers, and pending tasks. ` +
    `Pay special attention to [Assistant reasoning] entries — these contain the rationale ` +
    `behind decisions and tool calls. Preserve the reasoning/rationale in your summary so ` +
    `that the assistant can recall WHY it made past decisions, not just WHAT it did. ` +
    `Target length: about ${targetChars} characters. ` +
    `Do not exceed ${targetChars} characters. If needed, prefer concise bullet-like phrasing over prose.\n\n` +
    `Conversation excerpt:\n${sourceText}`
  );
}

async function _summarizeTextAsync(
  model: LanguageModel,
  sourceText: string,
  targetTokens: number,
  phase: string,
): Promise<string> {
  const result = await generateTextWithRetryAsync({
    model,
    prompt: _buildSummarizationPrompt(sourceText, targetTokens),
    retryOptions: { callType: "summarization" },
  });

  const trimmedText: string = result.text?.trim() ?? "";
  if (trimmedText.length === 0) {
    throw new Error(`LLM returned empty summary for phase ${phase}`);
  }

  return trimmedText;
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

function _splitMessagesIntoChunks(
  messages: ModelMessage[],
  maxChunkTokens: number,
  countTokens: (msgs: ModelMessage[]) => number,
): ModelMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const chunks: ModelMessage[][] = [];
  let currentChunk: ModelMessage[] = [];
  let currentChunkTokens: number = 0;

  for (const message of messages) {
    const messageTokens: number = countTokens([message]);

    // If a single message exceeds the chunk size, put it in its own chunk
    if (messageTokens > maxChunkTokens) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChunkTokens = 0;
      }
      chunks.push([message]);
      continue;
    }

    // If adding this message would exceed the chunk size, start a new chunk
    if (currentChunkTokens + messageTokens > maxChunkTokens && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChunkTokens = 0;
    }

    currentChunk.push(message);
    currentChunkTokens += messageTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function _estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

//#endregion Private functions
