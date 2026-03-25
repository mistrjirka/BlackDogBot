import { ChatOpenAI } from "@langchain/openai";
import type { IAiConfig } from "../shared/types/config.types.js";
import { LoggerService } from "./logger.service.js";

//#region Public Functions

export function createChatModel(config: IAiConfig): ChatOpenAI {
  const logger: LoggerService = LoggerService.getInstance();
  const { baseURL, apiKey, model, timeout } = _resolveProviderConfig(config);

  logger.info("LangChain model created", { provider: config.provider, model, baseURL });

  return new ChatOpenAI({
    model,
    configuration: {
      baseURL,
      apiKey,
    },
    temperature: 0.7,
    maxRetries: 3,
    timeout,
  });
}

export function createFallbackChatModel(config: IAiConfig): ChatOpenAI | null {
  if (!config.fallbacks || config.fallbacks.length === 0) {
    return null;
  }

  const fallback = config.fallbacks[0];
  const logger: LoggerService = LoggerService.getInstance();

  const fbConfig = _resolveFallbackConfig(config, fallback);
  if (!fbConfig) {
    return null;
  }

  logger.info("LangChain fallback model created", {
    provider: fallback.provider,
    model: fbConfig.model,
    baseURL: fbConfig.baseURL,
  });

  return new ChatOpenAI({
    model: fbConfig.model,
    configuration: {
      baseURL: fbConfig.baseURL,
      apiKey: fbConfig.apiKey,
    },
    temperature: 0.7,
    maxRetries: 2,
    timeout: fbConfig.timeout,
  });
}

//#endregion Public Functions

//#region Private Functions

interface IResolvedProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeout: number;
}

function _resolveProviderConfig(config: IAiConfig): IResolvedProviderConfig {
  const defaultTimeout: number = 500000;

  if (config.provider === "openrouter" && config.openrouter) {
    return {
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.openrouter.apiKey,
      model: config.openrouter.model,
      timeout: defaultTimeout,
    };
  }

  if (config.provider === "openai-compatible" && config.openaiCompatible) {
    return {
      baseURL: config.openaiCompatible.baseUrl,
      apiKey: config.openaiCompatible.apiKey,
      model: config.openaiCompatible.model,
      timeout: config.openaiCompatible.requestTimeout ?? defaultTimeout,
    };
  }

  if (config.provider === "lm-studio" && config.lmStudio) {
    return {
      baseURL: config.lmStudio.baseUrl,
      apiKey: config.lmStudio.apiKey ?? "lm-studio",
      model: config.lmStudio.model,
      timeout: config.lmStudio.requestTimeout ?? defaultTimeout,
    };
  }

  throw new Error(`No provider configuration found for: ${config.provider}`);
}

function _resolveFallbackConfig(
  config: IAiConfig,
  fallback: { provider: string; model?: string },
): IResolvedProviderConfig | null {
  const defaultTimeout: number = 500000;

  if (fallback.provider === "openrouter" && config.openrouter) {
    return {
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.openrouter.apiKey,
      model: fallback.model ?? config.openrouter.model,
      timeout: defaultTimeout,
    };
  }

  if (fallback.provider === "openai-compatible" && config.openaiCompatible) {
    return {
      baseURL: config.openaiCompatible.baseUrl,
      apiKey: config.openaiCompatible.apiKey,
      model: fallback.model ?? config.openaiCompatible.model,
      timeout: config.openaiCompatible.requestTimeout ?? defaultTimeout,
    };
  }

  if (fallback.provider === "lm-studio" && config.lmStudio) {
    return {
      baseURL: config.lmStudio.baseUrl,
      apiKey: config.lmStudio.apiKey ?? "lm-studio",
      model: fallback.model ?? config.lmStudio.model,
      timeout: config.lmStudio.requestTimeout ?? defaultTimeout,
    };
  }

  return null;
}

//#endregion Private Functions
