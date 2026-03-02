import Bottleneck from "bottleneck";
import { LanguageModel } from "ai";
import { LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

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
  private _supportsForcedToolChoice: boolean | null = null;

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

    const logger = LoggerService.getInstance();
    const defaultLocalContextWindow = 32768;

    // Priority: 1. Config value, 2. API detection, 3. Conservative default
    if (activeConfig.contextWindow) {
      this._contextWindow = activeConfig.contextWindow;
      logger.info(`Using configured context window: ${this._contextWindow}`);
    } else if (providerKey === "lm-studio") {
      const lmConfig = activeConfig as ILmStudioConfig;
      const lmInfo = await this._modelInfoService.fetchLmStudioContextWindowAsync(
        lmConfig.baseUrl,
        defaultModelId,
      );

      if (lmInfo.loaded) {
        this._contextWindow = lmInfo.loaded;
        logger.info(`Detected LM Studio context window: ${this._contextWindow} (loaded)`);
      } else if (lmInfo.max) {
        this._contextWindow = lmInfo.max;
        logger.info(`Detected LM Studio context window: ${this._contextWindow} (max)`);
      } else {
        this._contextWindow = defaultLocalContextWindow;
        logger.warn(
          `Could not detect context window from LM Studio API. ` +
          `Using conservative default: ${defaultLocalContextWindow}. ` +
          `Set 'contextWindow' in config or ensure LM Studio server is running.`
        );
      }
    } else if (providerKey === "openrouter") {
      try {
        this._contextWindow = await this._modelInfoService.fetchContextWindowAsync(defaultModelId);
        logger.info(`Detected OpenRouter context window: ${this._contextWindow}`);
      } catch {
        this._contextWindow = defaultLocalContextWindow;
        logger.warn(
          `Could not detect context window from OpenRouter API. ` +
          `Using default: ${defaultLocalContextWindow}.`
        );
      }
    } else {
      // openai-compatible or other providers
      this._contextWindow = defaultLocalContextWindow;
      logger.warn(
        `No context window configured for ${providerKey} provider. ` +
        `Using conservative default: ${defaultLocalContextWindow}. ` +
        `Set 'contextWindow' in config for accurate compaction.`
      );
    }

    // Test forced tool choice capability and log result
    const supportsForced = await this.testForcedToolChoiceAsync();
    this._supportsForcedToolChoice = supportsForced;
    logger.info(`Model ${defaultModelId} forced tool choice: ${supportsForced ? "SUPPORTED" : "NOT SUPPORTED"}`);

    // Test response format to detect reasoning_content issue
    const responseFormat = await this.testResponseFormatAsync();
    logger.info(`Model ${defaultModelId} response format: ${responseFormat.ok ? "OK" : `ISSUE - ${responseFormat.reason}`}`);
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

    const logger = LoggerService.getInstance();
    const defaultLocalContextWindow = 32768;

    // Use config value if provided, otherwise use conservative default
    if (activeConfig.contextWindow) {
      this._contextWindow = activeConfig.contextWindow;
    } else {
      this._contextWindow = defaultLocalContextWindow;
      logger.warn(
        `No context window configured for ${providerKey} provider in sync initialization. ` +
        `Using default: ${defaultLocalContextWindow}. ` +
        `Call initializeAsync() for auto-detection or set 'contextWindow' in config.`
      );
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

  public supportsForcedToolChoice(): boolean {
    if (!this._aiConfig) {
      return false;
    }

    // OpenRouter models - some support forced tool choice, some don't
    // Default to false to be safe, can be overridden in config
    if (this._aiConfig.provider === "openrouter") {
      return this._aiConfig.openrouter?.supportsForcedToolChoice ?? false;
    }

    // LM Studio and OpenAI-compatible should generally work
    return true;
  }

  /**
   * Tests if the model supports forced tool choice by forcing a specific tool
   * and verifying the full flow works correctly (tool call + execution + result).
   * Returns true only if:
   * - Model returns a tool call with the correct tool name
   * - Tool executes without crashing
   * - Tool returns the expected result
   */
  public async testForcedToolChoiceAsync(): Promise<boolean> {
    if (!this._aiConfig || !this._defaultModel) {
      return false;
    }

    const logger = LoggerService.getInstance();
    logger.info("Testing model forced tool choice capability...");

    try {
      const { generateText, tool } = await import("ai");

      const calculatorTool = tool({
        description: "Performs basic arithmetic",
        inputSchema: z.object({
          a: z.number(),
          b: z.number(),
          operation: z.enum(["add", "subtract", "multiply", "divide"]),
        }),
        execute: async ({ a, b, operation }): Promise<string> => {
          switch (operation) {
            case "add":
              return String(a + b);
            case "subtract":
              return String(a - b);
            case "multiply":
              return String(a * b);
            case "divide":
              return b !== 0 ? String(a / b) : "Error: divide by zero";
          }
        },
      });

      const weatherTool = tool({
        description: "Gets weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }): Promise<string> => `Weather in ${city}: sunny, 72°F`,
      });

      const result = await generateText({
        model: this._defaultModel,
        messages: [{ role: "user", content: "What is 5 + 3?" }],
        tools: { calculator: calculatorTool, weather: weatherTool },
        toolChoice: { type: "tool" as const, toolName: "calculator" },
        maxOutputTokens: 200,
      });

      const hasToolCalls = result.toolCalls && result.toolCalls.length > 0;
      const hasCorrectTool = hasToolCalls && result.toolCalls.some(
        (tc) => tc.toolName === "calculator"
      );

      const toolResultRaw = result.toolResults?.[0];
      let hasCorrectResult = false;
      if (toolResultRaw && typeof toolResultRaw === "object") {
        const tr = toolResultRaw as Record<string, unknown>;
        if (tr.output !== undefined) {
          const outputObj = tr.output as Record<string, unknown>;
          if (outputObj && typeof outputObj === "object" && "value" in outputObj) {
            hasCorrectResult = String(outputObj.value).includes("8");
          }
        }
      }

      logger.info("Model forced tool choice test result", {
        hasToolCalls,
        hasCorrectTool,
        hasCorrectResult,
        finishReason: result.finishReason,
        text: result.text?.substring(0, 100),
        toolCallsCount: result.toolCalls?.length ?? 0,
        toolName: result.toolCalls?.[0]?.toolName,
        toolResult: hasCorrectResult ? "8" : "not matched",
      });

      return hasCorrectTool && hasCorrectResult;
    } catch (error) {
      logger.warn("Model forced tool choice test failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Tests if the model returns content in the correct field.
   * Some LM Studio configurations put content in reasoning_content instead of content.
   */
  public async testResponseFormatAsync(): Promise<{ ok: boolean; reason?: string }> {
    if (!this._aiConfig) {
      return { ok: false, reason: "Service not initialized" };
    }

    const logger = LoggerService.getInstance();
    logger.info("Testing model response format...");

    try {
      const config = this._getActiveProviderConfig();
      const baseUrl = (config as IOpenAiCompatibleConfig | ILmStudioConfig).baseUrl || "http://localhost:1234";

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "Reply with: hello" }],
          max_tokens: 20,
        }),
      });

      if (!response.ok) {
        return { ok: false, reason: `HTTP ${response.status}` };
      }

      const json = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            reasoning_content?: string;
          };
        }>;
      };
      const message = json.choices?.[0]?.message;

      if (!message) {
        return { ok: false, reason: "No message in response" };
      }

      const hasEmptyContent = !message.content || message.content === "";
      const hasReasoningContent = !!message.reasoning_content;

      if (hasEmptyContent && hasReasoningContent) {
        logger.warn(
          "Model response format issue detected: content is empty but reasoning_content has data. " +
          "This is usually caused by LM Studio artificially dividing reasoning content and content. " +
          "Please disable the automatic division of reasoning and non-reasoning content in LM Studio settings. " +
          "See: https://lmstudio.ai/docs/developer/openai-compat/structured-output"
        );
        return {
          ok: false,
          reason: "Content is in reasoning_content field - please disable LM Studio reasoning division",
        };
      }

      return { ok: true };
    } catch (error) {
      logger.warn("Model response format test failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  //#endregion Public methods

  //#region Private methods

  /**
   * Fixes responses where content is in reasoning_content instead of content.
   * Logs a warning and copies reasoning_content to content.
   */
  private async _fixReasoningContentResponse(response: Response): Promise<Response> {
    if (!response.ok) return response;

    try {
      const json = await response.clone().json() as {
        choices?: Array<{
          message?: {
            content?: string;
            reasoning_content?: string;
          };
        }>;
      };

      if (json.choices && Array.isArray(json.choices)) {
        let modified = false;

        for (const choice of json.choices) {
          const hasReasoningContent = choice.message?.reasoning_content;
          const hasEmptyContent = !choice.message?.content || choice.message.content === "";

          if (hasReasoningContent && hasEmptyContent) {
            if (!modified) {
              const logger = LoggerService.getInstance();
              logger.warn(
                "JSON structured output was found inside reasoning_content instead of content. " +
                "This is usually caused by LM Studio artificially dividing reasoning content and content. " +
                "Please disable the automatic division of reasoning and non-reasoning content in LM Studio settings. " +
                "See: https://lmstudio.ai/docs/developer/openai-compat/structured-output"
              );
            }

            choice.message!.content = choice.message!.reasoning_content;
            delete choice.message!.reasoning_content;
            modified = true;
          }
        }

        if (modified) {
          return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      }
    } catch {
      // Not JSON - ignore
    }

    return response;
  }

  /**
   * Normalizes tool_choice in request body if the provider doesn't support object format.
   * Returns true if the body was modified.
   */
  private _normalizeToolChoiceIfNeeded(body: Record<string, unknown>): boolean {
    if (this._supportsForcedToolChoice === true) {
      return false;
    }

    if (body.tool_choice && typeof body.tool_choice === "object") {
      body.tool_choice = "auto";
      return true;
    }

    return false;
  }

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
        supportsStructuredOutputs: config.supportsStructuredOutputs ?? false,
        fetch: async (url, init): Promise<Response> => {
          if (init?.body && typeof init.body === "string" && init.method === "POST") {
            try {
              const body = JSON.parse(init.body);
              if (this._normalizeToolChoiceIfNeeded(body)) {
                init.body = JSON.stringify(body);
              }
            } catch {
              // Ignore parse errors, let the original fetch handle the bad payload
            }
          }
          const response = await fetch(url, init);
          return this._fixReasoningContentResponse(response);
        },
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
        supportsStructuredOutputs: config.supportsStructuredOutputs ?? true, // LM Studio supports response_format: json_schema by default
        fetch: async (url, init): Promise<Response> => {
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

              if (this._normalizeToolChoiceIfNeeded(body)) {
                modified = true;
              }

              if (modified) {
                init.body = JSON.stringify(body);
              }
            } catch {
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

          // Fix reasoning_content issue (content in wrong field)
          return this._fixReasoningContentResponse(response);
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
