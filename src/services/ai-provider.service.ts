import Bottleneck from "bottleneck";
import { LanguageModel, wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { LanguageModelV3, SharedV3ProviderOptions } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LMStudioClient } from "@lmstudio/sdk";

import { LoggerService } from "./logger.service.js";
import { SchedulerService } from "./scheduler.service.js";
import {
  IAiConfig,
  AiProvider,
  IRateLimitConfig,
  IOpenRouterConfig,
  IOpenAiCompatibleConfig,
  ILmStudioConfig,
  ResolvedStructuredOutputMode,
  StructuredOutputMode,
  ILlmResponse,
  ILlmToolCall,
} from "../shared/types/index.js";
import { RateLimiterService } from "./rate-limiter.service.js";
import { ModelInfoService } from "./model-info.service.js";
import {
  ModelProfileService,
  IRequestBehaviorProfile,
  ModelProfileOperation,
} from "./model-profile.service.js";
import { countRequestBodyTokens, IRequestTokenBreakdown } from "../utils/request-token-counter.js";
import { extractErrorMessage } from "../utils/error.js";
import { FORCE_THINK_INTERVAL } from "../shared/constants.js";
import { getCurrentLlmCallType } from "../utils/llm-call-context.js";
import { runToolCallingProbeAsync } from "../utils/llm-probe-helpers.js";
import { createHash } from "node:crypto";

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
const PARALLEL_TOOL_CALL_PROBE_TIMEOUT_MS: number = 60000;
const DEFAULT_REQUEST_TIMEOUT_MS: number = 500_000; // 500 seconds
const REQUEST_TIMEOUT_RETRY_MULTIPLIER: number = 2;
const REQUEST_TIMEOUT_MAX_ATTEMPTS: number = 2; // initial + 1 retry
const OPENROUTER_FREE_MODEL_RPM_LIMIT: number = 20;

const STRUCTURED_OUTPUT_STRATEGY_AUTO: StructuredOutputMode = "auto";

export class AiProviderService {
  //#region Data members

  private static _instance: AiProviderService | null;
  private _aiConfig: IAiConfig | null;
  private _rateLimiterService: RateLimiterService;
  private _modelInfoService: ModelInfoService;
  private _modelProfileService: ModelProfileService;
  private _defaultModel: LanguageModel | null;
  private _contextWindow: number;
  private _supportsStructuredOutputs: boolean = false;
  private _supportsReasoningFormat: boolean = false;
  private _supportsParallelToolCalls: boolean = false;
  private _supportsToolCalling: boolean = true;
  private _resolvedStructuredOutputMode: ResolvedStructuredOutputMode = "native_json_schema";
  private _requestTimeoutMs: number;
  private _activeProfileName: string | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._aiConfig = null;
    this._rateLimiterService = RateLimiterService.getInstance();
    this._modelInfoService = ModelInfoService.getInstance();
    this._modelProfileService = ModelProfileService.getInstance();
    this._defaultModel = null;
    this._contextWindow = 128000; // Default context window
    this._requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    this._activeProfileName = null;
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

    const providerKey: AiProvider = aiConfig.provider;
    const activeConfig: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();
    const logger = LoggerService.getInstance();

    const profilesDir: string | undefined = activeConfig.profilesDir;
    await this._modelProfileService.initializeAsync(profilesDir);
    this._activeProfileName = activeConfig.activeProfile ?? null;

    if (this._activeProfileName && !this._modelProfileService.hasProfile(this._activeProfileName)) {
      const logger = LoggerService.getInstance();
      logger.warn("Configured model profile not found; falling back to default behavior", {
        activeProfile: this._activeProfileName,
        profilesDir: this._modelProfileService.getProfilesDirectory(),
      });
      this._activeProfileName = null;
    }

    const defaultModelId: string = this._getActiveModelId();

    const effectiveRateLimits: IRateLimitConfig = this._resolveEffectiveRateLimits(
      providerKey,
      activeConfig.rateLimits,
      defaultModelId,
      logger,
    );

    this._rateLimiterService.getOrCreateLimiter(providerKey, effectiveRateLimits);

    this._defaultModel = this._createModel(defaultModelId);

    const defaultLocalContextWindow = 32768;

    // Priority: 1. Config value, 2. SDK detection (LM Studio) or API detection, 3. Conservative default
    if (activeConfig.contextWindow) {
      this._contextWindow = activeConfig.contextWindow;
      logger.info(`Using configured context window: ${this._contextWindow}`);
    } else if (this._isLmStudio(providerKey)) {
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
    } else if (this._isOpenRouter(providerKey)) {
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

    // Test response format to detect reasoning_content issue
    const responseFormat = await this.testResponseFormatAsync();
    logger.info(`Model ${defaultModelId} response format: ${responseFormat.ok ? "OK" : `ISSUE - ${responseFormat.reason}`}`);

    // Autodetect reasoning_format support (llama.cpp specific)
    if (this._isOpenAiCompatible(providerKey)) {
      this._supportsReasoningFormat = await this._testReasoningFormatSupportAsync();
      if (this._supportsReasoningFormat) {
        logger.info("Will use reasoning_format: 'none' with AI SDK client-side think-tag extraction middleware");
      }
    }

    // Detect/request capabilities and resolve strict structured output mode.
    await this._resolveStructuredOutputModeAsync(defaultModelId, logger);

    // Autodetect parallel tool call support (local openai-compatible endpoints)
    if (this._isLocalProvider(providerKey)) {
      this._supportsParallelToolCalls = await this._testParallelToolCallSupportAsync();
      logger.info(
        `Autodetected parallel tool call support: ${this._supportsParallelToolCalls ? "SUPPORTED" : "NOT SUPPORTED"}`,
      );

      // Resolve per-request timeout from config (local providers only)
      const configuredTimeout: number | undefined = this._isOpenAiCompatible(providerKey)
        ? aiConfig.openaiCompatible?.requestTimeout
        : aiConfig.lmStudio?.requestTimeout;
      this._requestTimeoutMs = configuredTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
      logger.info(`Per-request timeout: ${this._requestTimeoutMs / 1000}s (retry at ${(this._requestTimeoutMs * REQUEST_TIMEOUT_RETRY_MULTIPLIER) / 1000}s)`);
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

    const providerKey: AiProvider = aiConfig.provider;
    const activeConfig: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();
    const logger = LoggerService.getInstance();

    this._activeProfileName = activeConfig.activeProfile ?? null;

    const defaultModelId: string = this._getActiveModelId();

    const effectiveRateLimits: IRateLimitConfig = this._resolveEffectiveRateLimits(
      providerKey,
      activeConfig.rateLimits,
      defaultModelId,
      logger,
    );

    this._rateLimiterService.getOrCreateLimiter(providerKey, effectiveRateLimits);

    this._defaultModel = this._createModel(defaultModelId);

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

    // Sync mode cannot run capability probes. Resolve strict structured mode
    // using configured values and safe defaults.
    const configuredMode: StructuredOutputMode = activeConfig.structuredOutputMode ?? STRUCTURED_OUTPUT_STRATEGY_AUTO;
    if (configuredMode === "native_json_schema") {
      this._supportsStructuredOutputs = true;
      this._supportsToolCalling = true;
      this._resolvedStructuredOutputMode = "native_json_schema";
    } else if (configuredMode === "tool_emulated" || configuredMode === "tool_auto") {
      this._supportsStructuredOutputs = false;
      this._supportsToolCalling = true;
      this._resolvedStructuredOutputMode = configuredMode;
    } else {
      // Auto in sync init: use explicit endpoint flag when available, otherwise
      // conservative default that avoids response_format dependence.
      const explicitStructuredSupport: boolean | undefined = this._isOpenAiCompatible(providerKey)
        ? aiConfig.openaiCompatible?.supportsStructuredOutputs
        : this._isLmStudio(providerKey)
          ? aiConfig.lmStudio?.supportsStructuredOutputs
          : undefined;

      if (explicitStructuredSupport === true) {
        this._supportsStructuredOutputs = true;
        this._supportsToolCalling = true;
        this._resolvedStructuredOutputMode = "native_json_schema";
      } else {
        this._supportsStructuredOutputs = false;
        this._supportsToolCalling = true;
        this._resolvedStructuredOutputMode = "tool_emulated";
      }
    }

    logger.info("Structured output mode (sync init)", {
      provider: providerKey,
      model: defaultModelId,
      mode: this._resolvedStructuredOutputMode,
      supportsStructuredOutputs: this._supportsStructuredOutputs,
      supportsToolCalling: this._supportsToolCalling,
    });
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

  public get supportsParallelToolCalls(): boolean {
    return this._supportsParallelToolCalls;
  }

  public getStructuredOutputMode(): ResolvedStructuredOutputMode {
    return this._resolvedStructuredOutputMode;
  }

  public getSupportsStructuredOutputs(): boolean {
    return this._supportsStructuredOutputs;
  }

  public getSupportsToolCalling(): boolean {
    return this._supportsToolCalling;
  }

  public getStructuredProviderOptions(): SharedV3ProviderOptions | undefined {
    if (!this._aiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    if (this._aiConfig.provider !== "openrouter") {
      return undefined;
    }

    return {
      openrouter: {
        provider: {
          require_parameters: true,
        },
      },
    };
  }

  /**
   * Returns the token count at which the fetch-level hard gate rejects requests.
   * Equal to contextWindow * HARD_GATE_THRESHOLD_PERCENTAGE (85%).
   */
  public getHardLimitTokens(): number {
    return Math.floor(this._contextWindow * HARD_GATE_THRESHOLD_PERCENTAGE);
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
       const baseUrl: string = this._getLocalBaseUrl(config);
 
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
 
        const json = await response.json() as ILlmResponse;
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
      const baseUrl: string = this._getLocalBaseUrl(config);

      // Build probe request body — include reasoning_format: "none" when supported
      // to prevent thinking models from wasting tokens on reasoning instead of
      // producing the constrained JSON output directly in content.
      const probeBody: Record<string, unknown> = {
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
      };

      if (this._supportsReasoningFormat) {
        probeBody.reasoning_format = "none";
      }

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(probeBody),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.debug("Structured output probe: server returned error", {
          status: response.status,
          body: body.substring(0, 200),
        });
        return false;
      }

      const json = await response.json() as ILlmResponse;

      // Try to extract valid JSON from content or reasoning_content.
      // Some models/servers put structured output in reasoning_content instead of content,
      // or content may contain non-JSON think tags. Try both fields robustly.
      const message = json.choices?.[0]?.message;
      const candidates: string[] = [
        message?.content ?? "",
        message?.reasoning_content ?? "",
      ].filter((s: string): boolean => s.length > 0);

      for (const candidate of candidates) {
        // Strip think tags that some models wrap around their output
        const stripped: string = candidate.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        const textToParse: string = stripped.length > 0 ? stripped : candidate;

        try {
          const parsed = JSON.parse(textToParse) as Record<string, unknown>;
          const isValid: boolean = typeof parsed.ok === "boolean";
          if (isValid) {
            logger.info("Structured output probe result: SUPPORTED");
            return true;
          }
        } catch {
          // Not valid JSON in this candidate, try next
        }
      }

      logger.debug("Structured output probe: no candidate contained valid schema-conformant JSON", {
        content: (message?.content ?? "").substring(0, 200),
        reasoningContent: (message?.reasoning_content ?? "").substring(0, 200),
      });
      return false;
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
   *
   * Important: for tool-call responses, keep reasoning_content separate so the
   * AI SDK can round-trip it in history as reasoning_content (client-side
   * think-tag extraction flow).
   */
  private async _fixReasoningContentResponse(response: Response): Promise<Response> {
    if (!response.ok) return response;

    try {
      const parseToolCallReasoningFromContent = (originalContent: string): {
        reasoningContent: string | null;
        cleanedContent: string;
      } => {
        const thinkTagRegex: RegExp = /<think>([\s\S]*?)<\/think>/g;
        const matches: RegExpMatchArray[] = Array.from(originalContent.matchAll(thinkTagRegex));

        if (matches.length > 0) {
          const reasoningParts: string[] = matches
            .map((match: RegExpMatchArray): string => (match[1] ?? "").trim())
            .filter((part: string): boolean => part.length > 0);

          const cleanedContent: string = originalContent
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .trim();

          return {
            reasoningContent: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : null,
            cleanedContent,
          };
        }

        const closingTag: string = "</think>";
        const closingIndex: number = originalContent.indexOf(closingTag);

        if (closingIndex !== -1) {
          const reasoningContent: string = originalContent
            .slice(0, closingIndex)
            .trim();
          const cleanedContent: string = originalContent
            .slice(closingIndex + closingTag.length)
            .trim();

          return {
            reasoningContent: reasoningContent.length > 0 ? reasoningContent : null,
            cleanedContent,
          };
        }

        return {
          reasoningContent: null,
          cleanedContent: originalContent,
        };
      };

      const json = await response.clone().json() as ILlmResponse;

      if (json.choices && Array.isArray(json.choices)) {
        let modified = false;

        for (const choice of json.choices) {
          const hasReasoningContent = choice.message?.reasoning_content;
          const hasEmptyContent = !choice.message?.content || choice.message.content === "";
          const hasToolCalls =
            Array.isArray(choice.message?.tool_calls) &&
            choice.message.tool_calls.length > 0;

          const rawContent: string | undefined = choice.message?.content;
          if (hasToolCalls && typeof rawContent === "string" && rawContent.trim().length > 0) {
            const parsed = parseToolCallReasoningFromContent(rawContent);
            const existingReasoning: string = choice.message?.reasoning_content?.trim() ?? "";

            if (existingReasoning.length === 0 && parsed.reasoningContent) {
              choice.message!.reasoning_content = parsed.reasoningContent;
              modified = true;
            }

            if (parsed.cleanedContent.length === 0) {
              delete choice.message!.content;
              modified = true;
            } else if (parsed.cleanedContent !== rawContent) {
              choice.message!.content = parsed.cleanedContent;
              modified = true;
            }
          }

          if (hasReasoningContent && hasEmptyContent && !hasToolCalls) {
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

  private async _resolveStructuredOutputModeAsync(defaultModelId: string, logger: LoggerService): Promise<void> {
    if (!this._aiConfig) {
      return;
    }

    const providerKey: AiProvider = this._aiConfig.provider;
    const activeConfig: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();

    const configuredMode: StructuredOutputMode = activeConfig.structuredOutputMode ?? STRUCTURED_OUTPUT_STRATEGY_AUTO;

    if (configuredMode !== STRUCTURED_OUTPUT_STRATEGY_AUTO) {
      if (configuredMode === "native_json_schema") {
        this._supportsStructuredOutputs = true;
        this._supportsToolCalling = true;
        this._resolvedStructuredOutputMode = "native_json_schema";
      } else if (configuredMode === "tool_auto") {
        this._supportsStructuredOutputs = false;
        this._supportsToolCalling = true;
        this._resolvedStructuredOutputMode = "tool_auto";
      } else {
        this._supportsStructuredOutputs = false;
        this._supportsToolCalling = true;
        this._resolvedStructuredOutputMode = "tool_emulated";
      }

      logger.info("Using configured structured output mode", {
        provider: providerKey,
        model: defaultModelId,
        mode: this._resolvedStructuredOutputMode,
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
      });
      return;
    }

    // Auto mode: OpenRouter first tries model capability metadata.
    if (this._isOpenRouter(providerKey)) {
      const supportedParameters: Set<string> | null = await this._modelInfoService.fetchSupportedParametersAsync(defaultModelId);

      if (supportedParameters !== null) {
        const hasStructuredOutputs: boolean = supportedParameters.has("structured_outputs");
        const hasResponseFormat: boolean = supportedParameters.has("response_format");
        const hasTools: boolean = supportedParameters.has("tools");
        const hasToolChoice: boolean = supportedParameters.has("tool_choice");

        this._supportsStructuredOutputs = hasStructuredOutputs || hasResponseFormat;
        this._supportsToolCalling = hasTools;

        if (this._supportsStructuredOutputs) {
          this._resolvedStructuredOutputMode = "native_json_schema";
          logger.info("Structured output mode auto-resolved from OpenRouter model metadata", {
            provider: providerKey,
            model: defaultModelId,
            mode: this._resolvedStructuredOutputMode,
            supportsStructuredOutputs: this._supportsStructuredOutputs,
            supportsToolCalling: this._supportsToolCalling,
            source: "openrouter_model_metadata",
          });
          return;
        }

        if (hasTools && hasToolChoice) {
          this._resolvedStructuredOutputMode = "tool_emulated";
          logger.info("Structured output mode auto-resolved from OpenRouter model metadata", {
            provider: providerKey,
            model: defaultModelId,
            mode: this._resolvedStructuredOutputMode,
            supportsStructuredOutputs: this._supportsStructuredOutputs,
            supportsToolCalling: this._supportsToolCalling,
            source: "openrouter_model_metadata",
          });
          return;
        }

        if (hasTools) {
          this._resolvedStructuredOutputMode = "tool_auto";
          logger.info("Structured output mode auto-resolved from OpenRouter model metadata", {
            provider: providerKey,
            model: defaultModelId,
            mode: this._resolvedStructuredOutputMode,
            supportsStructuredOutputs: this._supportsStructuredOutputs,
            supportsToolCalling: this._supportsToolCalling,
            source: "openrouter_model_metadata",
          });
          return;
        }
      }
    }

    // Fallback probe path when capabilities are unavailable.
    const structuredOutputsProbe: boolean = await this.testStructuredOutputsAsync();
    this._supportsStructuredOutputs = structuredOutputsProbe;

    if (structuredOutputsProbe) {
      this._supportsToolCalling = true;
      this._resolvedStructuredOutputMode = "native_json_schema";
      logger.info("Structured output mode resolved via probe", {
        provider: providerKey,
        model: defaultModelId,
        mode: this._resolvedStructuredOutputMode,
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        source: "probe:structured_outputs",
      });
      return;
    }

    const toolCallingProbe: boolean = await this.testToolCallingSupportAsync();
    this._supportsToolCalling = toolCallingProbe;

    if (toolCallingProbe) {
      this._resolvedStructuredOutputMode = "tool_emulated";
      logger.info("Structured output mode resolved via probe", {
        provider: providerKey,
        model: defaultModelId,
        mode: this._resolvedStructuredOutputMode,
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        source: "probe:tool_calling",
      });
      return;
    }

    const softToolCallingProbe: boolean = await this.testToolCallingSoftSupportAsync();
    this._supportsToolCalling = softToolCallingProbe;

    if (softToolCallingProbe) {
      this._resolvedStructuredOutputMode = "tool_auto";
      logger.info("Structured output mode resolved via probe", {
        provider: providerKey,
        model: defaultModelId,
        mode: this._resolvedStructuredOutputMode,
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        source: "probe:tool_calling_soft",
      });
      return;
    }

    throw new Error(
      "Unable to resolve structured output mode: model supports neither native structured outputs " +
      "nor tool calling (strict or auto). Configure ai.<provider>.structuredOutputMode explicitly.",
    );
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
   * Tests whether the endpoint/model can return multiple tool calls in one response
   * when parallel_tool_calls is enabled.
   *
   * Probe strategy (A/B):
   * - Request A: parallel_tool_calls=true
   * - Request B: parallel_tool_calls=false
   *
   * Success criteria:
   * - A returns >=2 tool calls to get_weather
   * - B returns <=1 tool call to get_weather
   */
  private async _testParallelToolCallSupportAsync(): Promise<boolean> {
    if (!this._aiConfig) {
      return false;
    }

    const logger: LoggerService = LoggerService.getInstance();
    logger.info("Testing endpoint parallel tool call support...");

    try {
      const config = this._getActiveProviderConfig();
      const baseUrl: string = this._getLocalBaseUrl(config);

      const makeProbeRequestAsync = async (parallelToolCalls: boolean): Promise<Response> => {
        const controller: AbortController = new AbortController();
        const timeoutId: NodeJS.Timeout = setTimeout(
          () => controller.abort(),
          PARALLEL_TOOL_CALL_PROBE_TIMEOUT_MS,
        );

        try {
          return await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              model: config.model,
              messages: [
                {
                  role: "system",
                  content: "Call tools. Do not answer in natural language.",
                },
                {
                  role: "user",
                  content: "Get the weather for Prague and Brno.",
                },
              ],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "get_weather",
                    description: "Get weather for a city",
                    parameters: {
                      type: "object",
                      properties: {
                        city: { type: "string" },
                      },
                      required: ["city"],
                    },
                  },
                },
              ],
              tool_choice: "required",
              parallel_tool_calls: parallelToolCalls,
              max_tokens: 200,
            }),
          });
        } finally {
          clearTimeout(timeoutId);
        }
      };

      const responseWithParallel: Response = await makeProbeRequestAsync(true);
      if (!responseWithParallel.ok) {
        const body: string = await responseWithParallel.text();
        logger.debug("Parallel tool call probe (parallel=true) returned error", {
          status: responseWithParallel.status,
          body: body.substring(0, 300),
        });
        return false;
      }

      const responseWithoutParallel: Response = await makeProbeRequestAsync(false);
      if (!responseWithoutParallel.ok) {
        const body: string = await responseWithoutParallel.text();
        logger.debug("Parallel tool call probe (parallel=false) returned error", {
          status: responseWithoutParallel.status,
          body: body.substring(0, 300),
        });
        return false;
      }

      const jsonWithParallel = await responseWithParallel.json() as ILlmResponse;
      const jsonWithoutParallel = await responseWithoutParallel.json() as ILlmResponse;

      const toolCallsWithParallel: ILlmToolCall[] = jsonWithParallel.choices?.[0]?.message?.tool_calls ?? [];
      const toolCallsWithoutParallel: ILlmToolCall[] = jsonWithoutParallel.choices?.[0]?.message?.tool_calls ?? [];

      const getWeatherCallsWithParallel: number = toolCallsWithParallel.filter(
        (toolCall: ILlmToolCall) => toolCall.function?.name === "get_weather",
      ).length;
      const getWeatherCallsWithoutParallel: number = toolCallsWithoutParallel.filter(
        (toolCall: ILlmToolCall) => toolCall.function?.name === "get_weather",
      ).length;

      const looksSupported: boolean =
        getWeatherCallsWithParallel >= 2 && getWeatherCallsWithoutParallel <= 1;

      logger.info("Parallel tool call probe result", {
        supported: looksSupported,
        callsWithParallel: getWeatherCallsWithParallel,
        callsWithoutParallel: getWeatherCallsWithoutParallel,
      });

      return looksSupported;
    } catch (error: unknown) {
      logger.debug("Parallel tool call probe failed", {
        error: extractErrorMessage(error),
      });
      return false;
    }
  }

  public async testToolCallingSupportAsync(): Promise<boolean> {
    if (!this._aiConfig) {
      return false;
    }

    const logger: LoggerService = LoggerService.getInstance();
    logger.info("Testing tool calling support (tools + tool_choice)...");

    try {
      const config = this._getActiveProviderConfig();
      const provider: AiProvider = this._aiConfig.provider;

      if (provider === "openrouter") {
        const result = await runToolCallingProbeAsync({
          url: "https://openrouter.ai/api/v1/chat/completions",
          model: config.model,
          prompt: "Call the tool once.",
          toolChoice: "required",
          maxTokens: 50,
          apiKey: (config as IOpenRouterConfig).apiKey,
          providerPayload: {
            require_parameters: true,
          },
        });

        if (!result.ok) {
          logger.debug("Tool calling probe failed for OpenRouter", { status: result.status });
          return false;
        }

        return result.hasToolCalls;
      }

      const baseUrl: string = this._getLocalBaseUrl(config);
      const result = await runToolCallingProbeAsync({
        url: `${baseUrl}/v1/chat/completions`,
        model: config.model,
        prompt: "Call the tool once.",
        toolChoice: "required",
        maxTokens: 50,
      });

      if (!result.ok) {
        logger.debug("Tool calling probe failed for local provider", { status: result.status });
        return false;
      }

      return result.hasToolCalls;
    } catch (error: unknown) {
      logger.debug("Tool calling probe failed", {
        error: extractErrorMessage(error),
      });
      return false;
    }
  }

  public async testToolCallingSoftSupportAsync(): Promise<boolean> {
    if (!this._aiConfig) {
      return false;
    }

    const logger: LoggerService = LoggerService.getInstance();
    logger.info("Testing soft tool calling support (tools + tool_choice:auto)...");

    try {
      const config = this._getActiveProviderConfig();
      const provider: AiProvider = this._aiConfig.provider;

      if (provider === "openrouter") {
        const result = await runToolCallingProbeAsync({
          url: "https://openrouter.ai/api/v1/chat/completions",
          model: config.model,
          prompt: "Call the tool emit_probe once.",
          toolChoice: "auto",
          maxTokens: 80,
          apiKey: (config as IOpenRouterConfig).apiKey,
        });

        if (!result.ok) {
          logger.debug("Soft tool calling probe failed for OpenRouter", { status: result.status });
          return false;
        }

        return result.hasToolCalls;
      }

      const baseUrl: string = this._getLocalBaseUrl(config);
      const result = await runToolCallingProbeAsync({
        url: `${baseUrl}/v1/chat/completions`,
        model: config.model,
        prompt: "Call the tool emit_probe once.",
        toolChoice: "auto",
        maxTokens: 80,
      });

      if (!result.ok) {
        logger.debug("Soft tool calling probe failed for local provider", { status: result.status });
        return false;
      }

      return result.hasToolCalls;
    } catch (error: unknown) {
      logger.debug("Soft tool calling probe failed", {
        error: extractErrorMessage(error),
      });
      return false;
    }
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
      logger.info("Making API request to provider", {
        provider: providerName,
        url: typeof url === 'string' ? url : url.toString(),
        method: init?.method ?? 'GET',
        requestSizeBytes: init?.body && typeof init.body === "string" ? Buffer.byteLength(init.body, "utf8") : 0,
        requestBodyHash:
          init?.body && typeof init.body === "string"
            ? createHash("sha256").update(init.body).digest("hex").slice(0, 16)
            : null,
      });

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
          requestSizeBytes: Buffer.byteLength(init.body, "utf8"),
          requestSizeEstimate: `(~${Math.ceil(init.body.length / 4)} tokens est.)`,
        });

        if (tokenBreakdown.total > hardLimit) {
          const excessTokens = tokenBreakdown.total - hardLimit;
          const excessPercentage = (excessTokens / hardLimit * 100).toFixed(1);
          
          logger.warn("Context hard gate triggered — blocking request before API call", {
            provider: providerName,
            total: tokenBreakdown.total,
            hardLimit,
            contextWindow: this._contextWindow,
            utilization: `${utilization.toFixed(1)}%`,
            triggerReason: "token_count_exceeds_hard_limit",
            excessTokens,
            excessPercentage: `${excessPercentage}%`,
            // Log key message statistics that contributed to the overflow
            messageCount: tokenBreakdown.messageCount,
            toolCount: tokenBreakdown.toolCount,
            largestComponent: this._getLargestComponent(tokenBreakdown),
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

      // Make the actual API request with progressive timeout for local providers
      const isLocalProvider: boolean = providerName === "openai-compatible" || providerName === "lm-studio";
      let response!: Response;

      if (isLocalProvider && init?.method === "POST") {
        // Progressive timeout retry: on timeout, retry once with 2x timeout.
        // This handles local LLM servers that occasionally take longer than
        // expected to generate a response (non-streaming mode buffers entire
        // response before sending headers).
        let lastError: unknown;
        let succeeded: boolean = false;

        for (let timeoutAttempt: number = 0; timeoutAttempt < REQUEST_TIMEOUT_MAX_ATTEMPTS; timeoutAttempt++) {
          const timeoutMs: number = this._requestTimeoutMs * Math.pow(REQUEST_TIMEOUT_RETRY_MULTIPLIER, timeoutAttempt);
          const controller: AbortController = new AbortController();
          let wasOurTimeout: boolean = false;
          const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
            wasOurTimeout = true;
            controller.abort();
          }, timeoutMs);

          // Forward caller's abort signal so cancellation still works
          if (init.signal) {
            if (init.signal.aborted) {
              clearTimeout(timeoutId);
              throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
            }
            init.signal.addEventListener("abort", () => {
              clearTimeout(timeoutId);
              controller.abort(init.signal!.reason);
            }, { once: true });
          }

          try {
            response = await fetch(url, { ...init, signal: controller.signal });
            clearTimeout(timeoutId);
            succeeded = true;
            break;
          } catch (error: unknown) {
            clearTimeout(timeoutId);
            lastError = error;

            // If caller aborted (not our timeout), propagate immediately
            if (!wasOurTimeout) {
              throw error;
            }

            const isLastAttempt: boolean = timeoutAttempt >= REQUEST_TIMEOUT_MAX_ATTEMPTS - 1;
            const nextTimeoutMs: number = timeoutMs * REQUEST_TIMEOUT_RETRY_MULTIPLIER;

            if (isLastAttempt) {
              const schedulerService: SchedulerService = SchedulerService.getInstance();
              logger.error("API request timed out after all timeout retries", {
                provider: providerName,
                timeoutMs,
                totalAttempts: REQUEST_TIMEOUT_MAX_ATTEMPTS,
                providerTimeoutAttempt: timeoutAttempt + 1,
                providerTimeoutTotal: REQUEST_TIMEOUT_MAX_ATTEMPTS,
                url: typeof url === "string" ? url : url.toString(),
                concurrentCronTasks: schedulerService.getRunningTaskCount(),
                queuedCronTasks: schedulerService.getQueuedTaskCount(),
              });
              throw new Error(
                `Cannot connect to API: request timed out after ${timeoutMs / 1000}s ` +
                `(attempt ${timeoutAttempt + 1}/${REQUEST_TIMEOUT_MAX_ATTEMPTS})`,
              );
            }

            logger.warn("API request timed out, retrying with longer timeout", {
              provider: providerName,
              timeoutAttempt: timeoutAttempt + 1,
              providerTimeoutAttempt: timeoutAttempt + 1,
              providerTimeoutTotal: REQUEST_TIMEOUT_MAX_ATTEMPTS,
              timeoutMs,
              nextTimeoutMs,
              url: typeof url === "string" ? url : url.toString(),
              concurrentCronTasks: SchedulerService.getInstance().getRunningTaskCount(),
              queuedCronTasks: SchedulerService.getInstance().getQueuedTaskCount(),
            });
          }
        }

        if (!succeeded) {
          throw lastError ?? new Error("All timeout retry attempts exhausted");
        }
      } else {
        response = await fetch(url, init);
      }
      
      // Log response status for debugging
      logger.info("Received response from provider", {
        provider: providerName,
        status: response.status,
        statusText: response.statusText,
        url: typeof url === 'string' ? url : url.toString(),
        responseSizeApprox: response.headers.get('content-length') ?? 'unknown',
      });

      // Enhanced error logging for non-OK responses (before LM Studio self-healing)
      if (!response.ok) {
        try {
          const errorBody = await response.clone().text();
          logger.warn("Provider API returned error status", {
            provider: providerName,
            status: response.status,
            statusText: response.statusText,
            url: typeof url === 'string' ? url : url.toString(),
            errorBodyPreview: errorBody.substring(0, Math.min(1000, errorBody.length)) + 
                             (errorBody.length > 1000 ? "..." : ""),
            requestBodySample: init?.body && typeof init.body === "string"
              ? init.body.substring(0, Math.min(500, init.body.length)) + 
                (init.body.length > 500 ? "..." : "")
              : null,
          });
        } catch (bodyError) {
          logger.warn("Failed to read error response body", {
            provider: providerName,
            status: response.status,
            error: bodyError instanceof Error ? bodyError.message : String(bodyError),
          });
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
      const rawModel = createOpenRouter({
        apiKey: config.apiKey,
        fetch: this._createTokenGatedFetch("openrouter"),
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

              // Inject reasoning_format: "none" for llama.cpp servers
              // This disables server-side think-tag extraction so we can handle it client-side
              if (this._supportsReasoningFormat && !body.reasoning_format) {
                body.reasoning_format = "none";
                modified = true;
              }

              const requestBehavior: IRequestBehaviorProfile = this._resolveRequestBehaviorForCurrentCall();

              if (requestBehavior.reasoningFormat && body.reasoning_format !== requestBehavior.reasoningFormat) {
                body.reasoning_format = requestBehavior.reasoningFormat;
                modified = true;
              }

              if (
                requestBehavior.chatTemplateKwargs &&
                JSON.stringify(body.chat_template_kwargs ?? null) !== JSON.stringify(requestBehavior.chatTemplateKwargs)
              ) {
                body.chat_template_kwargs = requestBehavior.chatTemplateKwargs;
                modified = true;
              }

              // Inject parallel_tool_calls: true for servers that support it.
              // The @ai-sdk/openai-compatible provider never sends this parameter,
              // so without injection llama.cpp defaults to single tool call mode.
              const requestedParallelToolCalls: boolean | undefined = requestBehavior.parallelToolCalls;
              if (requestedParallelToolCalls !== undefined) {
                if (body.parallel_tool_calls !== requestedParallelToolCalls) {
                  body.parallel_tool_calls = requestedParallelToolCalls;
                  modified = true;
                }
              } else if (
                this._supportsParallelToolCalls &&
                body.parallel_tool_calls === undefined
              ) {
                body.parallel_tool_calls = true;
                modified = true;
              }

              // Strip empty content from assistant messages with tool_calls.
              // The SDK sends content: "" which confuses llama.cpp and causes
              // subsequent tool calls to fail (~66% failure rate).
              // Removing empty/whitespace-only content gives 100% success rate.
              if (body.messages && Array.isArray(body.messages)) {
                for (const msg of body.messages) {
                  const contentIsEmptyOrWhitespace: boolean =
                    typeof msg.content === "string" &&
                    msg.content.trim().length === 0;

                  if (
                    msg.role === "assistant" &&
                    msg.tool_calls &&
                    Array.isArray(msg.tool_calls) &&
                    msg.tool_calls.length > 0 &&
                    contentIsEmptyOrWhitespace
                  ) {
                    delete (msg as Record<string, unknown>).content;
                    modified = true;
                  }
                }
              }

              if (this._promoteReasoningToRequiredIfNeeded(body)) {
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
          return this._fixReasoningContentResponse(response);
        },
      }).chatModel(modelId);

      const modelWithReasoningExtraction: LanguageModel = this._supportsReasoningFormat
        ? wrapLanguageModel({
          model: rawModel,
          middleware: extractReasoningMiddleware({ tagName: "think" }),
        })
        : rawModel;

      return this._wrapModelWithRateLimiter(modelWithReasoningExtraction, provider);
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

  private _getLocalBaseUrl(config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig): string {
    return normalizeBaseUrl((config as IOpenAiCompatibleConfig | ILmStudioConfig).baseUrl || "http://localhost:1234");
  }

  private _isOpenRouter(providerKey: AiProvider): boolean {
    return providerKey === "openrouter";
  }

  private _isOpenAiCompatible(providerKey: AiProvider): boolean {
    return providerKey === "openai-compatible";
  }

  private _isLmStudio(providerKey: AiProvider): boolean {
    return providerKey === "lm-studio";
  }

  private _isLocalProvider(providerKey: AiProvider): boolean {
    return this._isOpenAiCompatible(providerKey) || this._isLmStudio(providerKey);
  }

  private _resolveEffectiveRateLimits(
    providerKey: AiProvider,
    configuredRateLimits: IRateLimitConfig,
    modelId: string,
    logger: LoggerService,
  ): IRateLimitConfig {
    if (providerKey !== "openrouter") {
      return configuredRateLimits;
    }

    if (!modelId.toLowerCase().endsWith(":free")) {
      return configuredRateLimits;
    }

    if (configuredRateLimits.rpm <= OPENROUTER_FREE_MODEL_RPM_LIMIT) {
      return configuredRateLimits;
    }

    const clampedRateLimits: IRateLimitConfig = {
      ...configuredRateLimits,
      rpm: OPENROUTER_FREE_MODEL_RPM_LIMIT,
      ...(configuredRateLimits.maxConcurrent !== undefined
        ? { maxConcurrent: Math.min(configuredRateLimits.maxConcurrent, OPENROUTER_FREE_MODEL_RPM_LIMIT) }
        : {}),
    };

    logger.warn("OpenRouter free model detected: clamping local RPM to align with upstream free-tier limits", {
      modelId,
      configuredRpm: configuredRateLimits.rpm,
      effectiveRpm: clampedRateLimits.rpm,
      configuredMaxConcurrent: configuredRateLimits.maxConcurrent,
      effectiveMaxConcurrent: clampedRateLimits.maxConcurrent,
    });

    return clampedRateLimits;
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

  private _getLargestComponent(breakdown: IRequestTokenBreakdown): string {
    const components = [
      { name: 'messages', value: breakdown.messages },
      { name: 'tools', value: breakdown.tools },
      { name: 'system', value: breakdown.system },
      { name: 'overhead', value: breakdown.overhead },
    ];
    const largest = components.reduce((max, comp) => comp.value > max.value ? comp : max);
    return `${largest.name} (${largest.value} tokens)`;
  }

  private _resolveRequestBehaviorForCurrentCall(): IRequestBehaviorProfile {
    if (!this._activeProfileName) {
      return {};
    }

    try {
      const currentCallType = getCurrentLlmCallType();
      const operation: ModelProfileOperation = currentCallType ?? "agent_primary";
      const behavior: IRequestBehaviorProfile | null =
        this._modelProfileService.resolveRequestBehavior(this._activeProfileName, operation);

      return behavior ?? {};
    } catch {
      return {};
    }
  }

  private _promoteReasoningToRequiredIfNeeded(body: Record<string, unknown>): boolean {
    const messagesUnknown: unknown = body.messages;
    const toolsUnknown: unknown = body.tools;

    if (!Array.isArray(messagesUnknown) || !Array.isArray(toolsUnknown)) {
      return false;
    }

    const stepsSinceReasoningOrThink: number = this._stepsSinceLastReasoningOrThink(messagesUnknown);
    if (stepsSinceReasoningOrThink < FORCE_THINK_INTERVAL) {
      return false;
    }

    let modified: boolean = false;

    for (const tool of toolsUnknown) {
      if (typeof tool !== "object" || tool === null) {
        continue;
      }

      const functionDef: unknown = (tool as { function?: unknown }).function;
      if (typeof functionDef !== "object" || functionDef === null) {
        continue;
      }

      const parametersUnknown: unknown = (functionDef as { parameters?: unknown }).parameters;
      if (typeof parametersUnknown !== "object" || parametersUnknown === null) {
        continue;
      }

      const parameters = parametersUnknown as {
        properties?: Record<string, unknown>;
        required?: unknown;
      };

      if (!parameters.properties || typeof parameters.properties !== "object") {
        continue;
      }

      if (!("reasoning" in parameters.properties)) {
        continue;
      }

      const required: string[] = Array.isArray(parameters.required)
        ? parameters.required.filter((value: unknown): value is string => typeof value === "string")
        : [];

      if (!required.includes("reasoning")) {
        parameters.required = [...required, "reasoning"];
        modified = true;
      }
    }

    return modified;
  }

  private _stepsSinceLastReasoningOrThink(messages: unknown[]): number {
    let stepsCount: number = 0;

    for (let i: number = messages.length - 1; i >= 0; i--) {
      const message: unknown = messages[i];

      if (typeof message !== "object" || message === null) {
        continue;
      }

      const role: unknown = (message as { role?: unknown }).role;
      const toolCalls: unknown = (message as { tool_calls?: unknown }).tool_calls;

      if (role !== "assistant" || !Array.isArray(toolCalls)) {
        continue;
      }

      let hasRelevantToolCalls: boolean = false;
      let hasThink: boolean = false;
      let hasReasoning: boolean = false;

      for (const toolCall of toolCalls) {
        if (typeof toolCall !== "object" || toolCall === null) {
          continue;
        }

        const functionCall: unknown = (toolCall as { function?: unknown }).function;
        if (typeof functionCall !== "object" || functionCall === null) {
          continue;
        }

        const name: unknown = (functionCall as { name?: unknown }).name;
        if (typeof name !== "string") {
          continue;
        }

        if (name === "done") {
          continue;
        }

        hasRelevantToolCalls = true;

        if (name === "think") {
          hasThink = true;
          continue;
        }

        const argumentsRaw: unknown = (functionCall as { arguments?: unknown }).arguments;
        const parsedArgs: unknown = this._parseToolArguments(argumentsRaw);

        if (this._hasNonEmptyReasoning(parsedArgs)) {
          hasReasoning = true;
        }
      }

      if (hasRelevantToolCalls) {
        if (hasThink || hasReasoning) {
          return stepsCount;
        }

        stepsCount++;
      }
    }

    return stepsCount;
  }

  private _parseToolArguments(argumentsRaw: unknown): unknown {
    if (typeof argumentsRaw === "string") {
      try {
        return JSON.parse(argumentsRaw);
      } catch {
        return argumentsRaw;
      }
    }

    return argumentsRaw;
  }

  private _hasNonEmptyReasoning(toolArgs: unknown): boolean {
    if (typeof toolArgs !== "object" || toolArgs === null) {
      return false;
    }

    const reasoning: unknown = (toolArgs as { reasoning?: unknown }).reasoning;

    return typeof reasoning === "string" && reasoning.trim().length > 0;
  }

  //#endregion Private methods
}
