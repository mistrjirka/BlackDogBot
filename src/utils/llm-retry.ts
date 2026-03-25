/**
 * @deprecated PHASE 5 - This file will be deleted when Vercel AI SDK is removed.
 * LLM retries are handled by LangChain's built-in retry mechanism.
 * See MIGRATION_PLAN.md Phase 5 for deletion timeline.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { z } from "zod";
import { randomUUID } from "node:crypto";

import { LoggerService } from "../services/logger.service.js";
import { RateLimiterService } from "../services/rate-limiter.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { extractAiErrorDetails, formatAiErrorForLog } from "./ai-error.js";
import { getConnectionRetryDelayMs, isConnectionError } from "./context-error.js";
import { apply429BackoffAsync } from "./rate-limit-retry.js";
import { runWithLlmCallTypeAsync } from "./llm-call-context.js";

//#region Types

export type LlmCallType = "agent_primary" | "summarization" | "schema_extraction" | "cron_history" | "job_execution";

export interface ILlmRetryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  callType?: LlmCallType;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120000;

const CALL_TYPE_POLICY: Record<LlmCallType, { maxAttempts: number; timeoutMs: number }> = {
  agent_primary: { maxAttempts: 3, timeoutMs: 120000 },
  summarization: { maxAttempts: 2, timeoutMs: 600000 },
  schema_extraction: { maxAttempts: 2, timeoutMs: 60000 },
  cron_history: { maxAttempts: 1, timeoutMs: 30000 },
  job_execution: { maxAttempts: 2, timeoutMs: 60000 },
};

//#endregion Types

//#region Interfaces

export interface IGenerateTextOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any; // Accepts both ChatOpenAI and legacy LanguageModel
  prompt: string;
  system?: string;
  retryOptions?: ILlmRetryOptions;
}

export interface IGenerateObjectOptions<T extends z.ZodType> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any; // Accepts both ChatOpenAI and legacy LanguageModel
  prompt: string;
  schema: T;
  system?: string;
  retryOptions?: ILlmRetryOptions;
}

//#endregion Interfaces

//#region Private Helpers

function getRetryPolicy(callType?: LlmCallType): { maxAttempts: number; timeoutMs: number } {
  if (callType && CALL_TYPE_POLICY[callType]) {
    return CALL_TYPE_POLICY[callType];
  }
  return { maxAttempts: DEFAULT_MAX_ATTEMPTS, timeoutMs: DEFAULT_TIMEOUT_MS };
}

function createLinkedAbortSignal(
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (!abortSignal && timeoutMs === Infinity) {
    return undefined;
  }

  const controller = new AbortController();

  const abortFn = (): void => {
    controller.abort();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
      return controller.signal;
    }
    abortSignal.addEventListener("abort", abortFn);
  }

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  controller.signal.addEventListener("abort", () => {
    clearTimeout(timeoutId);
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortFn);
    }
  });

  return controller.signal;
}

function estimateTokensFromTextByBytes(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function estimateTokensFromPromptAndSystem(prompt: string, system?: string): number {
  const promptBytes: number = Buffer.byteLength(prompt, "utf8");
  const systemBytes: number = system ? Buffer.byteLength(system, "utf8") : 0;
  return Math.ceil((promptBytes + systemBytes) / 4);
}

function buildMessages(prompt: string, system?: string): BaseMessage[] {
  const messages: BaseMessage[] = [];
  if (system) {
    messages.push({ _getType: () => "system", content: system } as BaseMessage);
  }
  messages.push({ _getType: () => "user", content: prompt } as BaseMessage);
  return messages;
}

//#endregion Private Helpers

//#region Public functions

export async function generateTextWithRetryAsync(
  options: IGenerateTextOptions,
): Promise<{ text: string }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  const providerKey: string = AiProviderService.getInstance().getActiveProvider();

  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "agent_primary";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = retryOptions.timeoutMs ?? policy.timeoutMs;

  const llmCallId = randomUUID();
  let lastError: unknown;

  const inputTokensEstimate: number = estimateTokensFromPromptAndSystem(options.prompt, options.system);

  statusService.beginInFlight("llm_request", "Waiting for response", {
    inputTokens: inputTokensEstimate,
    inputTokensSource: "estimate_bytes",
    callType,
    llmCallId,
  });

  try {
    for (let attempt: number = 1; attempt <= maxAttempts; attempt++) {
      try {
        const linkedSignal = createLinkedAbortSignal(retryOptions.abortSignal, timeoutMs);

        const callFn = async (): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
          const messages: BaseMessage[] = buildMessages(options.prompt, options.system);

          const invokeOptions: Record<string, unknown> = {
            signal: linkedSignal,
          };

          const result = await options.model.invoke(messages, invokeOptions);

          const text: string = typeof result === "string"
            ? result
            : result.content && typeof result.content === "string"
              ? result.content
              : JSON.stringify(result);

          const inputTokens: number = inputTokensEstimate;
          const outputTokens: number = estimateTokensFromTextByBytes(text);

          return {
            text,
            inputTokens,
            outputTokens,
          };
        };

        const result: { text: string; inputTokens: number; outputTokens: number } =
          await runWithLlmCallTypeAsync(callType, callFn);

        rateLimiterService.recordTokenUsage(providerKey, result.inputTokens, result.outputTokens);

        logger.info("LLM call succeeded", {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          inputTokensEstimate,
          inputTokensActual: result.inputTokens,
          outputTokensActual: result.outputTokens,
          sdkRetriesDisabled: true,
        });

        return { text: result.text };
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));

        const isAbort = error instanceof Error && error.name === "AbortError";

        logger.warn("LLM call failed" + (isAbort ? " (aborted)" : ""), {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          localRetryAttempt: attempt,
          localRetryTotal: maxAttempts,
          retryLayer: "local",
          sdkRetriesDisabled: true,
          error: errorMessage,
          isAbort,
        });

        statusService.setStatus("llm_request", `Retrying (${attempt}/${maxAttempts})`, {
          inputTokens: inputTokensEstimate,
          inputTokensSource: "estimate_bytes",
          callType,
          llmCallId,
          error: errorMessage,
        });

        if (isAbort) {
          break;
        }

        if (extractAiErrorDetails(error).statusCode === 429) {
          await apply429BackoffAsync({
            logger,
            error,
            retryAttempt: attempt,
            logMessage: "LLM call rate limited (429), waiting before retry",
            logContext: {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
            },
          });
        } else {
          const isConnectionRelatedError: boolean = isConnectionError(error);
          if (isConnectionRelatedError) {
            const retryDelayMs: number = getConnectionRetryDelayMs(attempt);
            logger.warn("LLM call connection error, waiting before retry", {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
              retryDelayMs,
              retryType: "connection",
            });

            await new Promise<void>((resolve: () => void): void => {
              setTimeout(resolve, retryDelayMs);
            });
          }
        }
      }
    }
  } finally {
    statusService.endInFlight();
  }

  const finalErrorMsg = lastError instanceof Error
    ? lastError.message
    : String(lastError ?? "Unknown error");

  logger.error("LLM call failed after all retries", {
    llmCallId,
    callType,
    maxAttempts,
    localRetryTotal: maxAttempts,
    retryLayer: "local",
    sdkRetriesDisabled: true,
    error: finalErrorMsg,
  });

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM call failed after ${maxAttempts} retries: ${finalErrorMsg}`);
}

export async function generateObjectWithRetryAsync<T extends z.ZodType>(
  options: IGenerateObjectOptions<T>,
): Promise<{ object: z.infer<T> }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  const aiProviderService: AiProviderService = AiProviderService.getInstance();
  const providerKey: string = aiProviderService.getActiveProvider();

  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "schema_extraction";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = retryOptions.timeoutMs ?? policy.timeoutMs;

  const llmCallId = randomUUID();
  let lastError: unknown;

  const inputTokensEstimate: number = estimateTokensFromPromptAndSystem(options.prompt, options.system);

  statusService.beginInFlight("llm_request", "Waiting for structured response", {
    inputTokens: inputTokensEstimate,
    inputTokensSource: "estimate_bytes",
    callType,
    llmCallId,
  });

  try {
    for (let attempt: number = 1; attempt <= maxAttempts; attempt++) {
      try {
        const linkedSignal = createLinkedAbortSignal(retryOptions.abortSignal, timeoutMs);

        const callFn = async (): Promise<{ object: z.infer<T> }> => {
          const messages: BaseMessage[] = buildMessages(options.prompt, options.system);
          const structuredModel = options.model.withStructuredOutput(options.schema);

          const result = await structuredModel.invoke(messages, { signal: linkedSignal });

          return { object: result as z.infer<T> };
        };

        const result: { object: z.infer<T> } = await runWithLlmCallTypeAsync(callType, callFn);

        const outputTokensEstimate: number = estimateTokensFromTextByBytes(JSON.stringify(result.object));
        rateLimiterService.recordTokenUsage(providerKey, inputTokensEstimate, outputTokensEstimate);

        logger.info("LLM structured call succeeded", {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          sdkRetriesDisabled: true,
        });

        return result;
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));

        const isAbort = error instanceof Error && error.name === "AbortError";

        logger.warn("LLM structured call failed" + (isAbort ? " (aborted)" : ""), {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          localRetryAttempt: attempt,
          localRetryTotal: maxAttempts,
          retryLayer: "local",
          sdkRetriesDisabled: true,
          error: errorMessage,
          isAbort,
        });

        statusService.setStatus("llm_request", `Retrying (${attempt}/${maxAttempts})`, {
          inputTokens: inputTokensEstimate,
          inputTokensSource: "estimate_bytes",
          callType,
          llmCallId,
          error: errorMessage,
        });

        if (isAbort) {
          break;
        }

        if (extractAiErrorDetails(error).statusCode === 429) {
          await apply429BackoffAsync({
            logger,
            error,
            retryAttempt: attempt,
            logMessage: "LLM structured call rate limited (429), waiting before retry",
            logContext: {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
            },
          });
        } else {
          const isConnectionRelatedError: boolean = isConnectionError(error);
          if (isConnectionRelatedError) {
            const retryDelayMs: number = getConnectionRetryDelayMs(attempt);
            logger.warn("LLM structured call connection error, waiting before retry", {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
              retryDelayMs,
              retryType: "connection",
            });

            await new Promise<void>((resolve: () => void): void => {
              setTimeout(resolve, retryDelayMs);
            });
          }
        }
      }
    }
  } finally {
    statusService.endInFlight();
  }

  const finalErrorMsg = lastError instanceof Error
    ? lastError.message
    : String(lastError ?? "Unknown error");

  logger.error("LLM structured call failed after all retries", {
    llmCallId,
    callType,
    maxAttempts,
    localRetryTotal: maxAttempts,
    retryLayer: "local",
    sdkRetriesDisabled: true,
    error: finalErrorMsg,
  });

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM structured call failed after ${maxAttempts} retries: ${finalErrorMsg}`);
}

//#endregion Public functions
