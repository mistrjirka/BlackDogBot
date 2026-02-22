import { generateText, generateObject, type LanguageModel } from "ai";
import type { z } from "zod";

import { LoggerService } from "../services/logger.service.js";
import { RateLimiterService } from "../services/rate-limiter.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { extractAiErrorDetails, formatAiErrorForLog } from "./ai-error.js";

//#region Constants

const LLM_MAX_RETRIES: number = 3;

//#endregion Constants

//#region Interfaces

export interface IGenerateTextOptions {
  model: LanguageModel;
  prompt: string;
  system?: string;
}

export interface IGenerateObjectOptions<T extends z.ZodType> {
  model: LanguageModel;
  prompt: string;
  schema: T;
  system?: string;
}

//#endregion Interfaces

//#region Public functions

export async function generateTextWithRetryAsync(
  options: IGenerateTextOptions,
): Promise<{ text: string }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  const providerKey: string = AiProviderService.getInstance().getActiveProvider();
  const limiter = rateLimiterService.getLimiter(providerKey);
  let lastError: unknown;

  // Count input tokens for status display
  const inputTokens: number = statusService.countTokens(options.prompt) +
    (options.system ? statusService.countTokens(options.system) : 0);

  // Set status (in-flight)
  statusService.beginInFlight("llm_request", "Waiting for response", { inputTokens });

  try {
    for (let attempt: number = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
      try {
      const callFn = async (): Promise<{ text: string }> => {
        const result = await generateText({
          model: options.model,
          prompt: options.prompt,
          ...(options.system ? { system: options.system } : {}),
        });

        return { text: result.text ?? "" };
      };

      const result: { text: string } = limiter
        ? await rateLimiterService.scheduleAsync(providerKey, callFn)
        : await callFn();

      // Record token usage for budget tracking (estimate output tokens)
      const outputTokens: number = statusService.countTokens(result.text);
      rateLimiterService.recordTokenUsage(providerKey, inputTokens, outputTokens);

        return result;
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));

        logger.warn("LLM call failed, retrying", {
          attempt,
          maxRetries: LLM_MAX_RETRIES,
          error: errorMessage,
        });

        // Update status with retry info
        statusService.setStatus("llm_request", `Retrying (${attempt}/${LLM_MAX_RETRIES})`, {
          inputTokens,
          error: errorMessage,
        });
      }
    }
  } finally {
    statusService.endInFlight();
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM call failed after ${LLM_MAX_RETRIES} retries: ${String(lastError)}`);
}

/**
 * Generates structured output using generateObject with retry logic and rate limiting.
 * Guarantees valid JSON matching the provided Zod schema.
 */
export async function generateObjectWithRetryAsync<T extends z.ZodType>(
  options: IGenerateObjectOptions<T>,
): Promise<{ object: z.infer<T> }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  const providerKey: string = AiProviderService.getInstance().getActiveProvider();
  const limiter = rateLimiterService.getLimiter(providerKey);
  let lastError: unknown;

  // Count input tokens for status display
  const inputTokens: number = statusService.countTokens(options.prompt) +
    (options.system ? statusService.countTokens(options.system) : 0);

  // Set status (in-flight)
  statusService.beginInFlight("llm_request", "Waiting for structured response", { inputTokens });

  try {
    for (let attempt: number = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
      try {
      const callFn = async (): Promise<{ object: z.infer<T> }> => {
        const result = await generateObject({
          model: options.model,
          prompt: options.prompt,
          schema: options.schema,
          ...(options.system ? { system: options.system } : {}),
        });

        return { object: result.object };
      };

      const result: { object: z.infer<T> } = limiter
        ? await rateLimiterService.scheduleAsync(providerKey, callFn)
        : await callFn();

      // Record token usage for budget tracking (estimate output tokens from JSON)
      const outputTokens: number = statusService.countTokens(JSON.stringify(result.object));
      rateLimiterService.recordTokenUsage(providerKey, inputTokens, outputTokens);

        return result;
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));

        logger.warn("LLM generateObject call failed, retrying", {
          attempt,
          maxRetries: LLM_MAX_RETRIES,
          error: errorMessage,
        });

        // Update status with retry info
        statusService.setStatus("llm_request", `Retrying (${attempt}/${LLM_MAX_RETRIES})`, {
          inputTokens,
          error: errorMessage,
        });
      }
    }
  } finally {
    statusService.endInFlight();
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM generateObject call failed after ${LLM_MAX_RETRIES} retries: ${String(lastError)}`);
}

//#endregion Public functions
