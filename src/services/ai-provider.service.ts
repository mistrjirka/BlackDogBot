import Bottleneck from "bottleneck";
import { LanguageModel } from "ai";
import { LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { LoggerService } from "./logger.service.js";
import {
  IAiConfig,
  AiProvider,
  IOpenRouterConfig,
  IOpenAiCompatibleConfig,
  ILmStudioConfig,
} from "../shared/types/index.js";
import { RateLimiterService } from "./rate-limiter.service.js";
import { ModelInfoService } from "./model-info.service.js";

export class AiProviderService {
  //#region Data members

  private static _instance: AiProviderService | null;
  private _aiConfig: IAiConfig | null;
  private _rateLimiterService: RateLimiterService;
  private _modelInfoService: ModelInfoService;
  private _defaultModel: LanguageModel | null;
  private _contextWindow: number;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._aiConfig = null;
    this._rateLimiterService = RateLimiterService.getInstance();
    this._modelInfoService = ModelInfoService.getInstance();
    this._defaultModel = null;
    this._contextWindow = 128000; // Default context window
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): AiProviderService {
    if (!AiProviderService._instance) {
      AiProviderService._instance = new AiProviderService();
    }

    return AiProviderService._instance;
  }

  public async initializeAsync(aiConfig: IAiConfig): Promise<void> {
    this._aiConfig = aiConfig;

    const providerKey: string = aiConfig.provider;
    const activeConfig: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();

    this._rateLimiterService.createLimiter(providerKey, activeConfig.rateLimits);

    const defaultModelId: string = this._getActiveModelId();
    this._defaultModel = this._createModel(defaultModelId);

    // Fetch context window from OpenRouter API if available
    if (providerKey === "openrouter") {
      try {
        this._contextWindow = await this._modelInfoService.fetchContextWindowAsync(defaultModelId);
      } catch {
        // Keep default if fetch fails
      }
    } else if (activeConfig.contextWindow) {
      this._contextWindow = activeConfig.contextWindow;
    }
  }

  public initialize(aiConfig: IAiConfig): void {
    // Sync wrapper - does not fetch context window from API
    // Use initializeAsync() for full initialization
    this._aiConfig = aiConfig;

    const providerKey: string = aiConfig.provider;
    const activeConfig: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();

    this._rateLimiterService.createLimiter(providerKey, activeConfig.rateLimits);

    const defaultModelId: string = this._getActiveModelId();
    this._defaultModel = this._createModel(defaultModelId);

    // Use config value if provided, otherwise keep default
    if (activeConfig.contextWindow) {
      this._contextWindow = activeConfig.contextWindow;
    }
  }

  public getDefaultModel(): LanguageModel {
    if (!this._aiConfig || !this._defaultModel) {
      throw new Error("AiProviderService not initialized");
    }

    return this._defaultModel;
  }

  public getModel(modelId?: string): LanguageModel {
    if (!this._aiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    if (!modelId) {
      return this.getDefaultModel();
    }

    return this._createModel(modelId);
  }

  public getActiveProvider(): AiProvider {
    if (!this._aiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    return this._aiConfig.provider;
  }

  public getRateLimiter(): Bottleneck {
    if (!this._aiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    const providerKey: string = this._aiConfig.provider;
    const limiter: Bottleneck | undefined =
      this._rateLimiterService.getLimiter(providerKey);

    if (!limiter) {
      throw new Error(
        `No rate limiter found for provider "${providerKey}". Call initialize() first.`,
      );
    }

    return limiter;
  }

  public getContextWindow(): number {
    return this._contextWindow;
  }

  //#endregion Public methods

  //#region Private methods

  private _wrapModelWithRateLimiter(model: LanguageModel, providerKey: string): LanguageModel {
    const originalModel: LanguageModelV3 = model as unknown as LanguageModelV3;

    const wrappedModel: LanguageModelV3 = {
      ...originalModel,
      doGenerate: async (options) => {
        return this._rateLimiterService.scheduleAsync(providerKey, async () =>
          Promise.resolve(originalModel.doGenerate(options))
        );
      },
      doStream: async (options) => {
        return this._rateLimiterService.scheduleAsync(providerKey, async () =>
          Promise.resolve(originalModel.doStream(options))
        );
      },
    };

    return wrappedModel as unknown as LanguageModel;
  }

  private _createModel(modelId: string): LanguageModel {
    if (!this._aiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    const provider: AiProvider = this._aiConfig.provider;

    if (provider === "openrouter") {
      if (!this._aiConfig.openrouter) {
        throw new Error(
          `No configuration found for provider: ${provider}`,
        );
      }

      const config: IOpenRouterConfig = this._aiConfig.openrouter;
      const rawModel = createOpenRouter({ apiKey: config.apiKey }).chat(modelId);
      return this._wrapModelWithRateLimiter(rawModel, provider);
    }

    if (provider === "openai-compatible") {
      if (!this._aiConfig.openaiCompatible) {
        throw new Error(
          `No configuration found for provider: ${provider}`,
        );
      }

      const config: IOpenAiCompatibleConfig = this._aiConfig.openaiCompatible;
      const rawModel = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        supportsStructuredOutputs: true, // Assume generic OpenAI-compatible APIs support response_format: json_schema
      }).chatModel(modelId);
      return this._wrapModelWithRateLimiter(rawModel, provider);
    }

    if (provider === "lm-studio") {
      if (!this._aiConfig.lmStudio) {
        throw new Error(
          `No configuration found for provider: ${provider}`,
        );
      }

      const config: ILmStudioConfig = this._aiConfig.lmStudio;
      const rawModel = createOpenAICompatible({
        name: "lm-studio",
        baseURL: config.baseUrl,
        apiKey: config.apiKey || "lm-studio",
        supportsStructuredOutputs: true, // LM Studio supports response_format: json_schema
        fetch: async (url, init): Promise<Response> => {
          // Intercept the request to fix LM Studio quirks with AI SDK.
          if (init?.body && typeof init.body === "string" && init.method === "POST") {
            try {
              const body = JSON.parse(init.body);
              let modified = false;

              // Fix missing tool schema discriminator (LM Studio requires type: "object")
              if (body.tools && Array.isArray(body.tools)) {
                for (const tool of body.tools) {
                  if (tool.type === "function" && tool.function?.parameters) {
                    if (tool.function.parameters.type !== "object") {
                      tool.function.parameters.type = "object";
                      modified = true;
                    }
                  }
                }
              }

              // Fix unsupported tool_choice object (LM Studio only supports string enums)
              // AI SDK sends { type: "function", function: { name: "tool_name" } } when forcing a tool
              if (body.tool_choice && typeof body.tool_choice === "object") {
                // If it's forcing a tool, we degrade to "auto" (or "required" if the model supports it, but "auto" is safer)
                body.tool_choice = "auto";
                modified = true;
              }

              if (modified) {
                init.body = JSON.stringify(body);
              }
            } catch (e) {
              // Ignore parse errors, let the original fetch handle the bad payload
            }
          }
          const response = await fetch(url, init);

          // Log failed requests to help debug LM Studio compatibility issues
          if (!response.ok) {
            const logger: LoggerService = LoggerService.getInstance();
            const responseText = await response.text();
            logger.error("LM Studio request rejected", {
              status: response.status,
              responseBody: responseText,
              requestBody: typeof init?.body === "string" ? init.body.substring(0, 2000) : "(non-string body)",
            });
            // Re-wrap in a new Response so the AI SDK can still read it
            return new Response(responseText, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }

          return response;
        }
      }).chatModel(modelId);
      return this._wrapModelWithRateLimiter(rawModel, provider);
    }

    throw new Error(`Unsupported provider: ${provider as string}`);
  }

  private _getActiveModelId(): string {
    const config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();

    return config.model;
  }

  private _getActiveProviderConfig():
    | IOpenRouterConfig
    | IOpenAiCompatibleConfig
    | ILmStudioConfig {
    if (!this._aiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    const provider: AiProvider = this._aiConfig.provider;

    if (provider === "openrouter") {
      if (!this._aiConfig.openrouter) {
        throw new Error(
          `No configuration found for provider: ${provider}`,
        );
      }
      return this._aiConfig.openrouter;
    }

    if (provider === "openai-compatible") {
      if (!this._aiConfig.openaiCompatible) {
        throw new Error(
          `No configuration found for provider: ${provider}`,
        );
      }
      return this._aiConfig.openaiCompatible;
    }

    if (provider === "lm-studio") {
      if (!this._aiConfig.lmStudio) {
        throw new Error(
          `No configuration found for provider: ${provider}`,
        );
      }
      return this._aiConfig.lmStudio;
    }

    throw new Error(
      `No configuration found for provider: ${provider as string}`,
    );
  }

  //#endregion Private methods
}
