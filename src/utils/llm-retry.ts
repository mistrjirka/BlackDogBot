import { generateText, type LanguageModel } from "ai";

import { LoggerService } from "../services/logger.service.js";
import { RateLimiterService } from "../services/rate-limiter.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";

//#region Constants

const LLM_MAX_RETRIES: number = 3;

//#endregion Constants

//#region Interfaces

export interface IGenerateTextOptions {
  model: LanguageModel;
  prompt: string;
  system?: string;
}

//#endregion Interfaces

//#region Public functions

export async function generateTextWithRetryAsync(
  options: IGenerateTextOptions,
): Promise<{ text: string }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const providerKey: string = AiProviderService.getInstance().getActiveProvider();
  const limiter = rateLimiterService.getLimiter(providerKey);
  let lastError: unknown;

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

      return result;
    } catch (error: unknown) {
      lastError = error;
      const errorMessage: string = error instanceof Error ? error.message : String(error);

      logger.warn("LLM call failed, retrying", {
        attempt,
        maxRetries: LLM_MAX_RETRIES,
        error: errorMessage,
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM call failed after ${LLM_MAX_RETRIES} retries: ${String(lastError)}`);
}

//#endregion Public functions
