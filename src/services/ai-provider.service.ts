import Bottleneck from "bottleneck";
import { LanguageModel } from "ai";
import { LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { LMStudioClient } from "@lmstudio/sdk";

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
import { countRequestBodyTokens, IRequestTokenBreakdown } from "../utils/request-token-counter.js";
import { extractErrorMessage } from "../utils/error.js";

function normalizeBaseUrl(url: string): string {
  const trimmed: string = url.trim();
  return trimmed.replace(/\/v1\/?$/, "");
}

/**
 * Hard gate threshold as a fraction of context window. Requests whose
 * serialized body exceeds this fraction are rejected before reaching the
 * API, triggering the compaction-retry logic in the agent.
 */
const HARD_GATE_THRESHOLD_PERCENTAGE: number = 0.85;
const LM_STUDIO_MODEL_RECOVERY_RETRIES: number = 3;

export class AiProviderService {
  //#region Data members

  private static _instance: AiProviderService | null;
  private _aiConfig: IAiConfig | null;
  private _rateLimiterService: RateLimiterService;
  private _modelInfoService: ModelInfoService;
  private _defaultModel: LanguageModel | null;
  private _contextWindow: number;
  private _supportsForcedToolChoice: boolean | null = null;
  private _supportsStructuredOutputs: boolean = false;
  private _supportsReasoningFormat: boolean = false;

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

    // Priority: 1. Config value, 2. SDK detection (LM Studio) or API detection, 3. Conservative default
    if (activeConfig.contextWindow) {
      this._contextWindow = activeConfig.contextWindow;
      logger.info(`Using configured context window: ${this._contextWindow}`);
    } else if (providerKey === "lm-studio") {
      const lmConfig = activeConfig as ILmStudioConfig;
      
      // Use LM Studio SDK for detection with retry
      const wsUrl: string = lmConfig.baseUrl.replace(/^http/, "ws");
      let detectedContext: number | null = null;
      
      try {
        const client = new LMStudioClient({ baseUrl: wsUrl });
        
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            // Load or get the model with the configured context length.
            // If contextWindow is set in config, pass it to ensure the model loads with that length.
            // If model is already loaded, this just returns the handle.
            const model = await client.llm.model(lmConfig.model, {
              config: lmConfig.contextWindow ? { contextLength: lmConfig.contextWindow } : undefined,
              verbose: true,
            });
            detectedContext = await model.getContextLength();
            break;
          } catch (error: unknown) {
            if (attempt < 3) {
              logger.debug(`LM Studio SDK attempt ${attempt}/3 failed, retrying...`, {
                error: error instanceof Error ? error.message : String(error),
              });
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
        }
      } catch (error: unknown) {
        logger.warn("Failed to initialize LM Studio SDK client", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      
      if (detectedContext) {
        this._contextWindow = detectedContext;
        logger.info(`Detected LM Studio context window: ${this._contextWindow}`);
      } else {
        this._contextWindow = defaultLocalContextWindow;
        logger.error(
          `Failed to detect LM Studio context window after 3 attempts. ` +
          `Using unsafe default: ${defaultLocalContextWindow}. ` +
          `Please set 'contextWindow' in config to match your LM Studio settings.`
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

    // Autodetect reasoning_format support (llama.cpp specific)
    if (providerKey === "openai-compatible") {
      this._supportsReasoningFormat = await this._testReasoningFormatSupportAsync();
      if (this._supportsReasoningFormat) {
        logger.info("Will use reasoning_format: 'none' with client-side think-tag extraction");
      }
    }

    // Autodetect structured output support when not explicitly configured
    if (providerKey === "openai-compatible" || providerKey === "lm-studio") {
      const explicitValue = providerKey === "openai-compatible"
        ? (aiConfig.openaiCompatible?.supportsStructuredOutputs)
        : (aiConfig.lmStudio?.supportsStructuredOutputs);

      if (explicitValue !== undefined) {
        this._supportsStructuredOutputs = explicitValue;
        logger.info(`Using configured supportsStructuredOutputs: ${explicitValue}`);
      } else {
        const detected = await this.testStructuredOutputsAsync();
        this._supportsStructuredOutputs = detected;
        logger.info(`Autodetected structured output support: ${detected ? "SUPPORTED" : "NOT SUPPORTED"}`);
      }
    }

    // Re-create model if any capability was detected that affects model creation
    if (this._supportsReasoningFormat || this._supportsStructuredOutputs) {
      this._defaultModel = this._createModel(defaultModelId);
      logger.info(
        "Re-created model with detected capabilities: " +
        `reasoningFormat=${this._supportsReasoningFormat}, structuredOutputs=${this._supportsStructuredOutputs}`,
      );
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

  /**
   * Returns the token count at which the fetch-level hard gate rejects requests.
   * Equal to contextWindow * HARD_GATE_THRESHOLD_PERCENTAGE (85%).
   */
  public getHardLimitTokens(): number {
    return Math.floor(this._contextWindow * HARD_GATE_THRESHOLD_PERCENTAGE);
  }

  public supportsForcedToolChoice(): boolean {
    // Use the actual test result from testForcedToolChoiceAsync() which runs at startup.
    // This must agree with _normalizeToolChoiceIfNeeded() which also uses the field
    // directly — otherwise the directive gets silently downgraded to "auto" in the
    // fetch interceptor while the caller believes it was sent as-is.
    return this._supportsForcedToolChoice === true;
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
        error: extractErrorMessage(error),
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
       const baseUrl = normalizeBaseUrl((config as IOpenAiCompatibleConfig | ILmStudioConfig).baseUrl || "http://localhost:1234");
 
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
         error: extractErrorMessage(error),
       });
       return { ok: false, reason: extractErrorMessage(error) };
     }
   }

  /**
   * Tests if the endpoint supports response_format: json_schema by sending
   * a small probe request. Returns true if the server handles it correctly.
   */
  public async testStructuredOutputsAsync(): Promise<boolean> {
    if (!this._aiConfig) {
      return false;
    }

    const logger = LoggerService.getInstance();
    logger.info("Testing endpoint structured output (response_format: json_schema) support...");

    try {
      const config = this._getActiveProviderConfig();
      const baseUrl = normalizeBaseUrl((config as IOpenAiCompatibleConfig | ILmStudioConfig).baseUrl || "http://localhost:1234");

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: 'Reply with: {"ok": true}' }],
          max_tokens: 50,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "probe",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                },
                required: ["ok"],
                additionalProperties: false,
              },
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.debug("Structured output probe: server returned error", {
          status: response.status,
          body: body.substring(0, 200),
        });
        return false;
      }

      const json = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            reasoning_content?: string;
          };
        }>;
      };

      const content = json.choices?.[0]?.message?.content
        || json.choices?.[0]?.message?.reasoning_content
        || "";

      // Try to parse the response as JSON to verify the server constrained the output
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const isValid = typeof parsed.ok === "boolean";
        logger.info(`Structured output probe result: ${isValid ? "SUPPORTED" : "response not schema-conformant"}`);
        return isValid;
      } catch {
        logger.debug("Structured output probe: response was not valid JSON", {
          content: content.substring(0, 200),
        });
        return false;
      }
    } catch (error) {
      logger.debug("Structured output probe failed", {
        error: extractErrorMessage(error),
      });
      return false;
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
   * Tests if the endpoint supports the reasoning_format parameter (llama.cpp specific).
   * Sends a minimal probe with reasoning_format: "none" — if the server accepts it,
   * we know we can use it to disable server-side think-tag extraction.
   */
  private async _testReasoningFormatSupportAsync(): Promise<boolean> {
    if (!this._aiConfig || !this._aiConfig.openaiCompatible) {
      return false;
    }

    const logger: LoggerService = LoggerService.getInstance();
    logger.info("Testing endpoint reasoning_format support...");

    try {
      const config: IOpenAiCompatibleConfig = this._aiConfig.openaiCompatible;
      const baseUrl: string = normalizeBaseUrl(config.baseUrl);

      const response: Response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "Say OK" }],
          max_tokens: 5,
          reasoning_format: "none",
        }),
      });

      if (response.ok) {
        logger.info("Endpoint supports reasoning_format parameter (llama.cpp detected)");
        return true;
      }

      logger.debug("Endpoint does not support reasoning_format parameter", {
        status: response.status,
      });
      return false;
    } catch (error: unknown) {
      logger.debug("reasoning_format probe failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Normalizes tool_choice in request body to avoid forced tool usage.
   * We enforce tool behavior by limiting the tools sent to the model,
   * not by forcing tool_choice.
   * Returns true if the body was modified.
   */
  private _normalizeToolChoiceIfNeeded(body: Record<string, unknown>): boolean {
    if (body.tool_choice && typeof body.tool_choice === "object") {
      body.tool_choice = "auto";
      return true;
    }

    if (body.tool_choice === "required") {
      body.tool_choice = "auto";
      return true;
    }

    return false;
  }

  /**
   * Ensures the model is loaded in LM Studio with the configured context length.
   * This is a get-or-load operation: if the model is already loaded, returns immediately.
   * If not loaded, loads it with the contextWindow from config.
   * Only runs for lm-studio provider; no-op for other providers.
   */
  private async _ensureModelLoadedAsync(): Promise<void> {
    if (this._aiConfig?.provider !== "lm-studio") {
      return;
    }

    const logger = LoggerService.getInstance();
    const lmConfig = this._getActiveProviderConfig() as ILmStudioConfig;
    const wsUrl: string = lmConfig.baseUrl.replace(/^http/, "ws");

    try {
      const client = new LMStudioClient({ baseUrl: wsUrl });

      await client.llm.model(lmConfig.model, {
        config: lmConfig.contextWindow ? { contextLength: lmConfig.contextWindow } : undefined,
        verbose: true,
      });

      logger.info("LM Studio model loaded successfully", {
        model: lmConfig.model,
        contextLength: lmConfig.contextWindow,
      });
    } catch (error: unknown) {
      logger.error("Failed to load LM Studio model", {
        model: lmConfig.model,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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

  /**
   * Creates a fetch wrapper that:
   * 1. Counts tokens of every POST request body (actual serialized size, not estimated).
   * 2. Logs the breakdown (messages / tools / system / overhead / utilization).
   * 3. Rejects requests whose total tokens exceed the hard gate (85% of context window)
   *    by returning a synthetic 400 "context_length_exceeded" response — this triggers
   *    the existing compaction-retry logic in BaseAgentBase.processMessageAsync.
   */
  private _createTokenGatedFetch(providerName: string): typeof fetch {
    const logger: LoggerService = LoggerService.getInstance();

    return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.body && typeof init.body === "string" && init.method === "POST") {
        const tokenBreakdown: IRequestTokenBreakdown = countRequestBodyTokens(init.body);
        const hardLimit: number = this.getHardLimitTokens();
        const utilization: number = (tokenBreakdown.total / this._contextWindow) * 100;

        logger.info("LLM API request tokens", {
          provider: providerName,
          total: tokenBreakdown.total,
          messages: tokenBreakdown.messages,
          tools: tokenBreakdown.tools,
          system: tokenBreakdown.system,
          overhead: tokenBreakdown.overhead,
          messageCount: tokenBreakdown.messageCount,
          toolCount: tokenBreakdown.toolCount,
          contextWindow: this._contextWindow,
          hardLimit,
          utilization: `${utilization.toFixed(1)}%`,
        });

        if (tokenBreakdown.total > hardLimit) {
          logger.warn("Context hard gate triggered — blocking request before API call", {
            provider: providerName,
            total: tokenBreakdown.total,
            hardLimit,
            contextWindow: this._contextWindow,
            utilization: `${utilization.toFixed(1)}%`,
          });

          // Return a synthetic 400 that mimics a real context-length API error.
          // The keywords "context" and "exceeded" are matched by BaseAgentBase to
          // trigger compaction and retry.
          const errorBody: string = JSON.stringify({
            error: {
              message:
                `Context size exceeded: ${tokenBreakdown.total} tokens exceeds ` +
                `hard limit of ${hardLimit} (${Math.round(HARD_GATE_THRESHOLD_PERCENTAGE * 100)}% ` +
                `of ${this._contextWindow} context window). Compaction required.`,
              type: "context_length_exceeded",
              code: "context_length_exceeded",
            },
          });

          return new Response(errorBody, {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Make the actual API request
      let response: Response = await fetch(url, init);

      // OpenRouter compatibility fallback: retry once with tool_choice:auto when
      // the route rejects forced tool_choice values.
      if (!response.ok && this._aiConfig?.provider === "openrouter" && init?.body && typeof init.body === "string") {
        try {
          const errorBody: string = await response.clone().text();
          const lowerErrorBody: string = errorBody.toLowerCase();
          const looksLikeToolChoiceRoutingError: boolean =
            lowerErrorBody.includes("tool_choice") &&
            (lowerErrorBody.includes("no endpoints found") ||
             lowerErrorBody.includes("support the provided"));

          if (looksLikeToolChoiceRoutingError) {
            const retryBody: Record<string, unknown> = JSON.parse(init.body);
            const wasModified: boolean = this._normalizeToolChoiceIfNeeded(retryBody);

            if (wasModified) {
              logger.warn("OpenRouter rejected tool_choice; retrying request with tool_choice:auto", {
                provider: providerName,
                status: response.status,
                url: url.toString(),
              });

              const retryInit: RequestInit = {
                ...init,
                body: JSON.stringify(retryBody),
              };

              response = await fetch(url, retryInit);
              if (response.ok) {
                return response;
              }
            }
          }
        } catch {
          // Ignore parse/retry errors and return original response
        }
      }

      // LM Studio self-healing: if model is unavailable/crashed, auto-load and retry up to 3 times.
      if (!response.ok && this._aiConfig?.provider === "lm-studio") {
        for (let attempt: number = 1; attempt <= LM_STUDIO_MODEL_RECOVERY_RETRIES; attempt++) {
          try {
            const body: string = await response.clone().text();

            let parsedRequestBody: unknown = null;
            if (init?.body && typeof init.body === "string") {
              try {
                parsedRequestBody = JSON.parse(init.body);
              } catch {
                parsedRequestBody = init.body;
              }
            }

            // Log the full response body for debugging
            logger.warn("LM Studio API error response", {
              provider: providerName,
              status: response.status,
              statusText: response.statusText,
              url: url.toString(),
              body: body.substring(0, 500), // Log first 500 chars to avoid huge logs
              requestBody: parsedRequestBody,
              attempt,
              maxRetries: LM_STUDIO_MODEL_RECOVERY_RETRIES,
            });

            // Check for various "model not loaded" / crash error patterns
            const lowerBody: string = body.toLowerCase();
            const isModelNotLoaded: boolean =
              lowerBody.includes("no models loaded") ||
              lowerBody.includes("no model is loaded") ||
              lowerBody.includes("model not loaded") ||
              lowerBody.includes("failed to load model") ||
              lowerBody.includes("unable to find model");
            const isModelCrashed: boolean =
              lowerBody.includes("model has crashed") ||
              lowerBody.includes("has crashed without additional information");

            if (!isModelNotLoaded && !isModelCrashed) {
              return response;
            }

            logger.warn("LM Studio model unavailable — attempting auto-load and retry...", {
              provider: providerName,
              reason: isModelCrashed ? "model_crashed" : "model_not_loaded",
              attempt,
              maxRetries: LM_STUDIO_MODEL_RECOVERY_RETRIES,
            });

            await this._ensureModelLoadedAsync();

            logger.info("Model loaded successfully, retrying original request...", {
              provider: providerName,
              attempt,
              maxRetries: LM_STUDIO_MODEL_RECOVERY_RETRIES,
            });

            response = await fetch(url, init);
            if (response.ok) {
              return response;
            }
          } catch (interceptError: unknown) {
            logger.debug("Failed to handle LM Studio auto-recovery", {
              error: interceptError instanceof Error ? interceptError.message : String(interceptError),
              attempt,
              maxRetries: LM_STUDIO_MODEL_RECOVERY_RETRIES,
            });
            return response;
          }
        }
      }

      return response;
    };
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
      const tokenGatedFetch = this._createTokenGatedFetch("openrouter");
      const rawModel = createOpenRouter({
        apiKey: config.apiKey,
        fetch: async (url, init): Promise<Response> => {
          if (init?.body && typeof init.body === "string" && init.method === "POST") {
            try {
              const body: Record<string, unknown> = JSON.parse(init.body);
              if (this._normalizeToolChoiceIfNeeded(body)) {
                init.body = JSON.stringify(body);
              }
            } catch {
              // Ignore parse errors
            }
          }

          return tokenGatedFetch(url, init);
        },
      }).chat(modelId);
      return this._wrapModelWithRateLimiter(rawModel, provider);
    }

    if (provider === "openai-compatible") {
      if (!this._aiConfig.openaiCompatible) {
        throw new Error(
          `No configuration found for provider: ${provider}`,
        );
      }

      const config: IOpenAiCompatibleConfig = this._aiConfig.openaiCompatible;
      const tokenGatedFetch = this._createTokenGatedFetch("openai-compatible");

      const rawModel = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: normalizeBaseUrl(config.baseUrl) + "/v1",
        apiKey: config.apiKey,
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        fetch: async (url, init): Promise<Response> => {
          // Apply transformations before calling token-gated fetch
          if (init?.body && typeof init.body === "string" && init.method === "POST") {
            try {
              const body = JSON.parse(init.body);
              let modified = false;

              // Strip response_format when endpoint doesn't support it.
              // When _supportsStructuredOutputs is true (autodetected or configured),
              // we let response_format through for native JSON schema support.
              if (body.response_format && !this._supportsStructuredOutputs) {
                delete body.response_format;
                modified = true;
              }

              if (this._normalizeToolChoiceIfNeeded(body)) {
                modified = true;
              }

              // Inject reasoning_format: "none" for llama.cpp servers
              // This disables server-side think-tag extraction so we can handle it client-side
              if (this._supportsReasoningFormat && !body.reasoning_format) {
                body.reasoning_format = "none";
                modified = true;
              }

              // Strip empty content from assistant messages with tool_calls.
              // The SDK sends content: "" which confuses llama.cpp and causes
              // subsequent tool calls to fail (~66% failure rate).
              // Removing the empty string entirely gives 100% success rate.
              if (body.messages && Array.isArray(body.messages)) {
                for (const msg of body.messages) {
                  if (
                    msg.role === "assistant" &&
                    msg.tool_calls &&
                    Array.isArray(msg.tool_calls) &&
                    msg.tool_calls.length > 0 &&
                    msg.content === ""
                  ) {
                    delete (msg as Record<string, unknown>).content;
                    modified = true;
                  }
                }
              }

              if (modified) {
                init.body = JSON.stringify(body);
              }
            } catch {
              // Ignore parse errors
            }
          }
          const response = await tokenGatedFetch(url, init);
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
      const tokenGatedFetch = this._createTokenGatedFetch("lm-studio");

      const rawModel = createOpenAICompatible({
        name: "lm-studio",
        baseURL: normalizeBaseUrl(config.baseUrl) + "/v1",
        apiKey: config.apiKey || "lm-studio",
        supportsStructuredOutputs: config.supportsStructuredOutputs ?? true,
        fetch: async (url, init): Promise<Response> => {
          // Apply transformations before calling token-gated fetch
          if (init?.body && typeof init.body === "string" && init.method === "POST") {
            try {
              const body = JSON.parse(init.body);
              let modified = false;

              // Fix tool schemas: LM Studio requires explicit type: "object"
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
              // Ignore parse errors
            }
          }
          const response = await tokenGatedFetch(url, init);

          // Log failed requests to help debug LM Studio compatibility issues
          if (!response.ok) {
            const logger: LoggerService = LoggerService.getInstance();
            logger.error("LM Studio API request failed", {
              status: response.status,
              statusText: response.statusText,
              url: url.toString(),
              requestBody: init?.body ? JSON.parse(init.body as string) : null,
            });
          }

          return this._fixReasoningContentResponse(response);
        },
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
