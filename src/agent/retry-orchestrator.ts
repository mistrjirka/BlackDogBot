import { type LanguageModel, type ModelMessage } from "ai";

import { AGENT_EMPTY_RESPONSE_RETRIES, CONTEXT_EXCEEDED_RETRIES } from "./base-agent.js";
import { DuplicateToolLoopHardStopError } from "./base-agent.js";
import type { LoggerService } from "../services/logger.service.js";
import { apply429BackoffAsync } from "../utils/rate-limit-retry.js";
import {
  isConnectionError,
  getConnectionRetryDelayMs,
  isContextExceededApiError,
  isRetryableApiError,
} from "../utils/context-error.js";
import { extractAiErrorDetails } from "../utils/ai-error.js";

//#region Types

interface IGenerateCallInput {
  messages: ModelMessage[];
  abortSignal: AbortSignal;
}

interface IGenerateCallOutput {
  text: string;
  steps?: unknown[];
  totalUsage?: Record<string, number | undefined>;
  usage?: Record<string, number | undefined>;
  response?: { messages?: unknown[] };
}

type TGenerateFn = (input: IGenerateCallInput) => Promise<IGenerateCallOutput>;

interface INotifyResult {
  text: string;
  stepsCount: number;
}

//#endregion Types

/** Configuration for one generation cycle execution. */
export interface IRetryOrchestratorConfig {
  /** Chat session identifier for logging context. */
  chatId: string;
  /** Logger instance used for structured logging and warnings. */
  logger: LoggerService;
  /** Language model reference for compaction when triggered by context errors. */
  model: LanguageModel;
  /** Max steps that will be passed to the agent for this cycle. */
  maxSteps: number;
  /** Token threshold above which messages are compacted (before headroom subtraction). */
  compactionThreshold: number;
  /** Full context window size, forwarded to compactMessagesSummaryOnlyAsync. */
  contextWindow: number;
  /** Function that performs one generate attempt. Receives messages and abort signal. */
  generateFn: TGenerateFn;
  /** Builds the current message list for each retry attempt. */
  buildMessagesForCall: () => ModelMessage[];
  /** Abort signal shared with the active chat request. */
  abortSignal: AbortSignal;
  /** Reset token counters before each retry attempt (mirrors MainAgent `_totalInputTokens`). */
  resetTokenCounters: () => void;
  /** Called with provider-reported input tokens after successfully generated response. Mirrors `_totalInputTokens = x`. */
  totalInputTokensSink: (value: number) => void;
  /** Emit model output text via brain interface emitter. Wrapped in try/catch inside runCycle. */
  emitModelOutputAsync: (chatId: string, stepNumber: number, text: string) => Promise<void>;
  /** Called when a context-exceeded error triggers compaction. The callback should compact
   *  session messages and return the new message list. If omitted, the retry continues
   *  without compaction (guaranteed to fail again with the same oversized context). */
  onContextExceededCompaction?: () => Promise<ModelMessage[]>;
}

/** Outcome returned after one complete runCycle execution. */
export interface IRunCycleResult {
  /** Agent result with response text and step count for returning to the caller. */
  result: INotifyResult;
  /** True when a fallback provider activation is needed (all retries exhausted or non-retryable error). */
  shouldFallback: boolean;
  /** Raw provider response messages to persist in session history. */
  responseMessages?: unknown[];
}

//#region Constants

/** Maximum number of rate limit (429) retries before giving up. */
const MAX_429_RETRIES: number = 8;

/** Maximum number of generic retryable API errors before giving up. */
const MAX_GENERIC_RETRIES: number = 3;

//#endregion Constants

//#region Class

export class RetryOrchestrator {
  /**
   * Run one generation cycle with full retry logic.
   *
   * This encapsulates the inner for-loop from MainAgent.processMessageForChatAsync:
   * - Empty response retries (AGENT_EMPTY_RESPONSE_RETRIES)
   * - Context size exceeded recovery via reactive compaction (CONTEXT_EXCEEDED_RETRIES)
   * - Rate-limited (429) backoff with increasing delays (MAX_429_RETRIES)
   * - Generic retryable API error recovery (MAX_GENERIC_RETRIES)
   * - Fallback provider activation when all retries are exhausted
   */
  static async runCycle(config: IRetryOrchestratorConfig): Promise<IRunCycleResult> {
    const {
      chatId,
      logger,
      generateFn,
      buildMessagesForCall,
      abortSignal,
      resetTokenCounters,
      totalInputTokensSink,
      emitModelOutputAsync,
      onContextExceededCompaction,
    } = config;

    let contextRetries: number = 0;
    let _429Retries: number = 0;
    let _genericRetries: number = 0;

    for (let attempt: number = 1; attempt <= AGENT_EMPTY_RESPONSE_RETRIES + 1; attempt++) {
      // Reset token count so prepareStep doesn't use stale values from a failed attempt
      resetTokenCounters();

      const llmStartTime: number = Date.now();
      try {
        const generateResult = await generateFn({
          messages: buildMessagesForCall(),
          abortSignal,
        });


        const latencyMs: number = Date.now() - llmStartTime;
        const stepsCount: number = generateResult.steps?.length || 1;

        const inputTokens: number | undefined =
          generateResult.totalUsage?.inputTokens ?? generateResult.usage?.inputTokens;
        const completionTokens: number | undefined =
          generateResult.totalUsage?.outputTokens ?? generateResult.usage?.outputTokens;


        if (inputTokens !== undefined) {
          totalInputTokensSink(inputTokens);
        } else {
          totalInputTokensSink(0);
          logger.warn("Token usage missing from LLM response; using tiktoken fallback.");
        }

        // Structured LLM logging
        logger.logStructured("llm", {
          chatId,
          providerInputTokens: inputTokens,
          estimatedInputTokens: 0, /* Caller handles `_estimatedInputTokens` externally */
          completionTokens,
          latencyMs,
          stepsCount,
        });

        if (generateResult.text) {
          try {
            await emitModelOutputAsync(chatId, stepsCount, generateResult.text);
          } catch {
            // Never let emit failures affect agent execution
          }
        }

        logger.debug("Agent response generated", { chatId, stepsCount });

        const text: string = generateResult.text ?? "";


        if (text.trim()) {
          /* Response appending and compaction handled by _runGenerationCycleAsync in main-agent */
          return {
            result: { text, stepsCount },
            shouldFallback: false,
            responseMessages: generateResult.response?.messages,
          };
        }

        // Empty response — retry if we have attempts left
        if (attempt <= AGENT_EMPTY_RESPONSE_RETRIES) {
          logger.warn("Model returned empty response for chat, retrying", {
            chatId,
            attempt,
            maxRetries: AGENT_EMPTY_RESPONSE_RETRIES,
          });
          continue;
        }

        // All retries exhausted — signal caller to activate fallback
        return {
          result: {
            text: "I was unable to complete your request — the model returned empty responses after multiple retries. Please try again.",
            stepsCount,
          },
          shouldFallback: true,
          responseMessages: undefined,
        };
      } catch (genError: unknown) {
        if (genError instanceof DuplicateToolLoopHardStopError) {
          throw genError;
        }

        if (genError instanceof Error && genError.name === "AbortError") {
          throw genError;
        }

        const aiErrorDetails = extractAiErrorDetails(genError);

        // Handle context size exceeded errors with reactive compaction
        if (isContextExceededApiError(genError) && contextRetries < CONTEXT_EXCEEDED_RETRIES) {
          contextRetries++;

          if (onContextExceededCompaction) {
            await onContextExceededCompaction();
            logger.info("Context compaction triggered, retrying with compacted messages", {
              chatId,
              contextRetry: contextRetries,
              maxContextRetries: CONTEXT_EXCEEDED_RETRIES,
            });
          } else {
            logger.warn("Context size exceeded but no compaction callback provided, retrying without compaction", {
              chatId,
              contextRetry: contextRetries,
              maxContextRetries: CONTEXT_EXCEEDED_RETRIES,
              statusCode: aiErrorDetails.statusCode,
            });
          }

          attempt--; // Don't burn the empty-response retry limit
          continue;
        }


        // Handle 429 rate limit errors with Retry-After wait
        const isRetriable429: boolean = aiErrorDetails.statusCode === 429 && _429Retries < MAX_429_RETRIES;
        if (isRetriable429) {
          _429Retries++;

          await apply429BackoffAsync({
            logger,
            error: genError,
            retryAttempt: _429Retries,
            logMessage: "Rate limited (429) in main agent loop, waiting before retry",
            logContext: { chatId, attempt, _429Retries },
          });

          attempt--; // Don't burn the empty-response retry budget
          continue;
        }


        // Handle generic retryable errors
        if (isRetryableApiError(genError) && _genericRetries < MAX_GENERIC_RETRIES) {
          _genericRetries++;
          const isConnectionRelatedError: boolean = isConnectionError(genError);
          const retryDelayMs: number = isConnectionRelatedError
            ? getConnectionRetryDelayMs(_genericRetries)
            : 0;

          logger.warn("Retryable API error in main agent loop, waiting before retry", {
            chatId,
            attempt,
            genericRetryCount: _genericRetries,
            maxGenericRetries: MAX_GENERIC_RETRIES,
            retryType: isConnectionRelatedError ? "connection" : "generic",
            retryDelayMs,
            statusCode: aiErrorDetails.statusCode,
          });

          if (retryDelayMs > 0) {
            await new Promise<void>((resolve: () => void): void => {
              setTimeout(resolve, retryDelayMs);
            });
          }


          attempt--; // Don't burn the empty-response retry budget
          continue;
        }


        // Non-retryable error — signal fallback to activate next provider
        return {
          result: { text: "An error occurred during generation.", stepsCount: 0 },
          shouldFallback: true,
        };
      }
    }

    // Should not be reached — all retries exhausted on empty response path
    return {
      result: { text: "Unexpected error.", stepsCount: 0 },
      shouldFallback: false,
    };
  }
}

//#endregion Class
