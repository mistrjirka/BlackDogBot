import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import { randomUUID } from "node:crypto";

import { LoggerService } from "../services/logger.service.js";
import { RateLimiterService } from "../services/rate-limiter.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { extractAiErrorDetails, formatAiErrorForLog } from "./ai-error.js";

//#region Types

export type LlmCallType = "agent_primary" | "tool_compaction" | "summarization" | "schema_extraction" | "cron_history" | "job_execution";

export interface ILlmRetryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  callType?: LlmCallType;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120000; // 120 seconds

// Policy defaults per call type
const CALL_TYPE_POLICY: Record<LlmCallType, { maxAttempts: number; timeoutMs: number }> = {
  agent_primary: { maxAttempts: 3, timeoutMs: 120000 },
  tool_compaction: { maxAttempts: 2, timeoutMs: 45000 },
  summarization: { maxAttempts: 2, timeoutMs: 60000 },
  schema_extraction: { maxAttempts: 2, timeoutMs: 60000 },
  cron_history: { maxAttempts: 1, timeoutMs: 30000 },
  job_execution: { maxAttempts: 2, timeoutMs: 60000 },
};

//#endregion Types

//#region Interfaces

export interface IGenerateTextOptions {
  model: LanguageModel;
  prompt: string;
  system?: string;
  retryOptions?: ILlmRetryOptions;
}

export interface IGenerateObjectOptions<T extends z.ZodType> {
  model: LanguageModel;
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

  // Clean up when signal aborts
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timeoutId);
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortFn);
    }
  });

  return controller.signal;
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
  const limiter = rateLimiterService.getLimiter(providerKey);

  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "agent_primary";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = retryOptions.timeoutMs ?? policy.timeoutMs;

  const llmCallId = randomUUID();
  let lastError: unknown;

  // Count input tokens for status display
  const inputTokens: number = statusService.countTokens(options.prompt) +
    (options.system ? statusService.countTokens(options.system) : 0);

  // Set status (in-flight)
  statusService.beginInFlight("llm_request", "Waiting for response", { inputTokens, callType, llmCallId });

  try {
    for (let attempt: number = 1; attempt <= maxAttempts; attempt++) {
      try {
        const linkedSignal = createLinkedAbortSignal(retryOptions.abortSignal, timeoutMs);

        const callFn = async (): Promise<{ text: string }> => {
          const result = await generateText({
            model: options.model,
            prompt: options.prompt,
            ...(options.system ? { system: options.system } : {}),
            maxRetries: 0, // Disable SDK retries - we manage retries ourselves
            abortSignal: linkedSignal,
          });

          return { text: result.text ?? "" };
        };

        const result: { text: string } = limiter
          ? await rateLimiterService.scheduleAsync(providerKey, callFn)
          : await callFn();

        // Record token usage for budget tracking (estimate output tokens)
        const outputTokens: number = statusService.countTokens(result.text);
        rateLimiterService.recordTokenUsage(providerKey, inputTokens, outputTokens);

        logger.info("LLM call succeeded", {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          inputTokens,
          outputTokens,
          sdkRetriesDisabled: true,
        });

        return result;
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));

        // Check if this was an abort (cancellation or timeout)
        const isAbort = error instanceof Error && error.name === "AbortError";

        logger.warn("LLM call failed" + (isAbort ? " (aborted)" : ""), {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          retryLayer: "local",
          sdkRetriesDisabled: true,
          error: errorMessage,
          isAbort,
        });

        // Update status with retry info
        statusService.setStatus("llm_request", `Retrying (${attempt}/${maxAttempts})`, {
          inputTokens,
          callType,
          llmCallId,
          error: errorMessage,
        });

        // Don't retry on abort (cancellation or timeout)
        if (isAbort) {
          break;
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
    retryLayer: "local",
    sdkRetriesDisabled: true,
    error: finalErrorMsg,
  });

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM call failed after ${maxAttempts} retries: ${finalErrorMsg}`);
}

/**
 * Generates structured output using generateText + Output.object() with retry logic
 * and rate limiting. Guarantees valid JSON matching the provided Zod schema.
 *
 * Uses generateText with Output.object() instead of generateObject — this extracts
 * structured JSON from the model's text response rather than relying on the provider
 * to support response_format: json_schema or tool-based JSON extraction. This makes
 * it compatible with all providers including llama.cpp, LM Studio, and OpenRouter,
 * while keeping full Zod schema validation.
 */
export async function generateObjectWithRetryAsync<T extends z.ZodType>(
  options: IGenerateObjectOptions<T>,
): Promise<{ object: z.infer<T> }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  const providerKey: string = AiProviderService.getInstance().getActiveProvider();
  const limiter = rateLimiterService.getLimiter(providerKey);

  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "schema_extraction";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = retryOptions.timeoutMs ?? policy.timeoutMs;

  const llmCallId = randomUUID();
  let lastError: unknown;

  // Count input tokens for status display
  const inputTokens: number = statusService.countTokens(options.prompt) +
    (options.system ? statusService.countTokens(options.system) : 0);

  // Set status (in-flight)
  statusService.beginInFlight("llm_request", "Waiting for structured response", { inputTokens, callType, llmCallId });

  try {
    for (let attempt: number = 1; attempt <= maxAttempts; attempt++) {
      try {
        const linkedSignal = createLinkedAbortSignal(retryOptions.abortSignal, timeoutMs);

        const callFn = async (): Promise<{ object: z.infer<T> }> => {
          const result = await generateText({
            model: options.model,
            prompt: options.prompt,
            ...(options.system ? { system: options.system } : {}),
            output: Output.object({ schema: options.schema }),
            maxRetries: 0, // Disable SDK retries - we manage retries ourselves
            abortSignal: linkedSignal,
          });

          if (result.output === undefined || result.output === null) {
            throw new Error(
              "No structured output generated: model did not return parseable JSON matching the schema." +
              (result.text ? ` Raw text: ${result.text.substring(0, 200)}` : ""),
            );
          }

          return { object: result.output };
        };

        const result: { object: z.infer<T> } = limiter
          ? await rateLimiterService.scheduleAsync(providerKey, callFn)
          : await callFn();

        // Record token usage for budget tracking (estimate output tokens from JSON)
        const outputTokens: number = statusService.countTokens(JSON.stringify(result.object));
        rateLimiterService.recordTokenUsage(providerKey, inputTokens, outputTokens);

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

        // Check if this was an abort (cancellation or timeout)
        const isAbort = error instanceof Error && error.name === "AbortError";

        logger.warn("LLM structured call failed" + (isAbort ? " (aborted)" : ""), {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          retryLayer: "local",
          sdkRetriesDisabled: true,
          error: errorMessage,
          isAbort,
        });

        // Update status with retry info
        statusService.setStatus("llm_request", `Retrying (${attempt}/${maxAttempts})`, {
          inputTokens,
          callType,
          llmCallId,
          error: errorMessage,
        });

        // Don't retry on abort (cancellation or timeout)
        if (isAbort) {
          break;
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
    retryLayer: "local",
    sdkRetriesDisabled: true,
    error: finalErrorMsg,
  });

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM structured call failed after ${maxAttempts} retries: ${finalErrorMsg}`);
}

//#endregion Public functions
