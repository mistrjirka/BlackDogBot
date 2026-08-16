import type Bottleneck from "bottleneck";
import type { LanguageModel } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { LMStudioClient } from "@lmstudio/sdk";
import { LoggerService } from "./logger.service.js";
import type { IAiConfig, AiProvider, IRateLimitConfig, IOpenRouterConfig, IOpenAiCompatibleConfig, ILmStudioConfig, IAiFallbackEntry, IProviderCapabilitySummary, ResolvedStructuredOutputMode, StructuredOutputMode } from "../shared/types/index.js";
import { AiProviderCore, type ICapabilityCacheEntry } from "./ai-provider/ai-provider-core.js";
import { extractErrorMessage } from "../utils/error.js";
import { MIN_GENERATION_TIMEOUT_FLOOR_MS, DEFAULT_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_RETRY_MULTIPLIER, STRUCTURED_OUTPUT_STRATEGY_AUTO } from "./ai-provider/ai-provider-core.js";

export class AiProviderService extends AiProviderCore {
  private static _instance: AiProviderService | null;

  private constructor() {
    super();
  }

  public static getInstance(): AiProviderService {
    if (!AiProviderService._instance) {
      AiProviderService._instance = new AiProviderService();
    }

    return AiProviderService._instance;
  }
  public async initializeAsync(
    aiConfig: IAiConfig,
    options?: {
      persistAsPrimary?: boolean;
      resetFallbackState?: boolean;
    },
  ): Promise<void> {
    const persistAsPrimary: boolean = options?.persistAsPrimary ?? true;
    const resetFallbackState: boolean = options?.resetFallbackState ?? true;

    this._aiConfig = aiConfig;
    this._supportsVision = false;

    const providerKey: AiProvider = aiConfig.provider;
    const activeConfig: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();
    const logger = LoggerService.getInstance();

    this._llmResponseDiagnosticsEnabled = this._resolveLlmResponseDiagnosticsEnabled();

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
    const capabilityCacheKey: string = this._getCapabilityCacheKey(defaultModelId);
    const cachedCapabilities: ICapabilityCacheEntry | null =
      await this._readCapabilityCacheEntryAsync(capabilityCacheKey);

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
      } catch (e: unknown) {
        this._contextWindow = defaultLocalContextWindow;
        logger.warn(
          `Could not detect context window from OpenRouter API. ` +
          `Using default: ${defaultLocalContextWindow}.`,
          { error: String(e) },
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
    let responseFormat: { ok: boolean; reason?: string };
    if (cachedCapabilities?.responseFormatOk === true) {
      responseFormat = {
        ok: true,
        reason: cachedCapabilities.responseFormatReason,
      };
      logger.info("Model response format loaded from cache", {
        provider: providerKey,
        model: defaultModelId,
        source: "capability_cache",
      });
    } else {
      if (cachedCapabilities?.responseFormatOk === false) {
        logger.info("Response format cache indicates issue; re-probing to avoid stale false negatives", {
          provider: providerKey,
          model: defaultModelId,
          source: "capability_cache",
        });
      }

      responseFormat = await this.testResponseFormatAsync();
      await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
        responseFormatOk: responseFormat.ok,
        responseFormatReason: responseFormat.reason,
      });
    }
    logger.info(`Model ${defaultModelId} response format: ${responseFormat.ok ? "OK" : `ISSUE - ${responseFormat.reason}`}`);

    // Autodetect reasoning_format support (llama.cpp specific)
    if (this._isOpenAiCompatible(providerKey)) {
      if (cachedCapabilities?.supportsReasoningFormat === true) {
        this._supportsReasoningFormat = true;
        logger.info("Endpoint reasoning_format support loaded from cache", {
          provider: providerKey,
          model: defaultModelId,
          supportsReasoningFormat: true,
          source: "capability_cache",
        });
      } else {
        if (cachedCapabilities?.supportsReasoningFormat === false) {
          logger.info("reasoning_format cache indicates unsupported; re-probing to avoid stale false negatives", {
            provider: providerKey,
            model: defaultModelId,
            source: "capability_cache",
          });
        }

        this._supportsReasoningFormat = await this._testReasoningFormatSupportAsync();
        await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
          supportsReasoningFormat: this._supportsReasoningFormat,
        });
      }

      if (this._supportsReasoningFormat) {
        logger.info("Will use reasoning_format: 'none' with AI SDK client-side think-tag extraction middleware");
      }
    }

    // Detect/request capabilities and resolve strict structured output mode.
    await this._resolveStructuredOutputModeAsync(defaultModelId, logger, capabilityCacheKey);

    await this._resolveVisionSupportAsync(defaultModelId, logger);

    // Autodetect parallel tool call support (local openai-compatible endpoints)
    if (this._isLocalProvider(providerKey)) {
      if (cachedCapabilities?.supportsParallelToolCalls === true) {
        this._supportsParallelToolCalls = true;
        logger.info("Parallel tool call support loaded from cache", {
          provider: providerKey,
          model: defaultModelId,
          supported: true,
          source: "capability_cache",
        });
      } else {
        if (cachedCapabilities?.supportsParallelToolCalls === false) {
          logger.info("Parallel tool call cache indicates unsupported; re-probing to avoid stale false negatives", {
            provider: providerKey,
            model: defaultModelId,
            source: "capability_cache",
          });
        }

        this._supportsParallelToolCalls = await this._testParallelToolCallSupportAsync();
        await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
          supportsParallelToolCalls: this._supportsParallelToolCalls,
        });
      }

      logger.info(
        `Autodetected parallel tool call support: ${this._supportsParallelToolCalls ? "SUPPORTED" : "NOT SUPPORTED"}`,
      );

      // Resolve per-request timeout from config (local providers only)
      const configuredTimeout: number | undefined = this._isOpenAiCompatible(providerKey)
        ? aiConfig.openaiCompatible?.requestTimeout
        : aiConfig.lmStudio?.requestTimeout;
      const generationTimeoutFloor: number = Math.max(
        aiConfig.generationTimeoutMs ?? MIN_GENERATION_TIMEOUT_FLOOR_MS,
        MIN_GENERATION_TIMEOUT_FLOOR_MS,
      );
      this._requestTimeoutMs = configuredTimeout
        ? Math.max(configuredTimeout, generationTimeoutFloor)
        : DEFAULT_REQUEST_TIMEOUT_MS;
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

    this._activeRuntimeProvider = aiConfig.provider;

    if (persistAsPrimary) {
      this._persistedAiConfig = this._cloneAiConfig(aiConfig);
      this._primaryProvider = aiConfig.provider;
      this._activeFallbackModelOverride = null;
    }

    if (resetFallbackState) {
      this._fallbackCursor = 0;
      if (persistAsPrimary) {
        this._activeFallbackModelOverride = null;
      }
    }
  }

  public initialize(aiConfig: IAiConfig): void {
    // Sync wrapper - does not fetch context window from API
    // Use initializeAsync() for full initialization
    this._aiConfig = aiConfig;
    this._supportsVision = false;

    const providerKey: AiProvider = aiConfig.provider;
    const activeConfig: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();
    const logger = LoggerService.getInstance();

    this._llmResponseDiagnosticsEnabled = this._resolveLlmResponseDiagnosticsEnabled();

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

    this._persistedAiConfig = this._cloneAiConfig(aiConfig);
    this._primaryProvider = aiConfig.provider;
    this._activeRuntimeProvider = aiConfig.provider;
    this._activeFallbackModelOverride = null;
    this._fallbackCursor = 0;
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
    if (!this._activeRuntimeProvider) {
      throw new Error("AiProviderService not initialized");
    }

    return this._activeRuntimeProvider;
  }

  public getPrimaryProvider(): AiProvider {
    if (!this._primaryProvider) {
      throw new Error("AiProviderService not initialized");
    }

    return this._primaryProvider;
  }

  public getFallbackChain(): IAiFallbackEntry[] {
    const persistedConfig: IAiConfig = this._getPersistedAiConfig();
    return [...(persistedConfig.fallbacks ?? [])];
  }

  public getActiveModelId(): string {
    return this._getActiveModelId();
  }

  public maskApiKey(apiKey: string | undefined): string {
    if (!apiKey || apiKey.trim().length === 0) {
      return "(not set)";
    }

    if (apiKey.length <= 8) {
      return "****";
    }

    return `****${apiKey.slice(-4)}`;
  }

  public async switchPrimaryProviderAsync(provider: AiProvider, modelOverride?: string): Promise<IProviderCapabilitySummary> {
    const nextConfig: IAiConfig = this._buildRuntimeConfigForProvider(provider, modelOverride);

    await this.initializeAsync(nextConfig, {
      persistAsPrimary: true,
      resetFallbackState: true,
    });

    await this._persistAiConfigAsync(nextConfig);

    return {
      provider: this.getActiveProvider(),
      model: this.getActiveModelId(),
      supportsStructuredOutputs: this.getSupportsStructuredOutputs(),
      supportsToolCalling: this.getSupportsToolCalling(),
      supportsVision: this.getSupportsVision(),
      contextWindow: this.getContextWindow(),
      structuredOutputMode: this.getStructuredOutputMode(),
    };
  }

  public async addOrUpdateProviderConfigAsync(provider: AiProvider, configPatch: Record<string, unknown>): Promise<void> {
    const persistedConfig: IAiConfig = this._getPersistedAiConfig();
    const nextConfig: IAiConfig = this._cloneAiConfig(persistedConfig);

    if (provider === "openrouter") {
      nextConfig.openrouter = {
        ...(nextConfig.openrouter ?? {} as IOpenRouterConfig),
        ...(configPatch as Partial<IOpenRouterConfig>),
      } as IOpenRouterConfig;
    } else if (provider === "openai-compatible") {
      nextConfig.openaiCompatible = {
        ...(nextConfig.openaiCompatible ?? {} as IOpenAiCompatibleConfig),
        ...(configPatch as Partial<IOpenAiCompatibleConfig>),
      } as IOpenAiCompatibleConfig;
    } else {
      nextConfig.lmStudio = {
        ...(nextConfig.lmStudio ?? {} as ILmStudioConfig),
        ...(configPatch as Partial<ILmStudioConfig>),
      } as ILmStudioConfig;
    }

    await this._persistAiConfigAsync(nextConfig);
  }

  public async addFallbackAsync(provider: AiProvider, modelOverride?: string): Promise<IProviderCapabilitySummary> {
    const persistedConfig: IAiConfig = this._getPersistedAiConfig();

    this._ensureProviderConfigured(persistedConfig, provider);

    const existingFallbacks: IAiFallbackEntry[] = [...(persistedConfig.fallbacks ?? [])];
    const filteredFallbacks: IAiFallbackEntry[] = existingFallbacks
      .filter((entry: IAiFallbackEntry): boolean => entry.provider !== provider);

    filteredFallbacks.push({
      provider,
      ...(modelOverride ? { model: modelOverride } : {}),
    });

    const nextConfig: IAiConfig = {
      ...this._cloneAiConfig(persistedConfig),
      fallbacks: filteredFallbacks,
    };

    await this._persistAiConfigAsync(nextConfig);

    return this.probeCapabilitiesForProviderModelAsync(
      provider,
      modelOverride ?? this._getProviderModelFromConfig(nextConfig, provider),
    );
  }

  public async removeFallbackAsync(provider: AiProvider): Promise<void> {
    const persistedConfig: IAiConfig = this._getPersistedAiConfig();
    const existingFallbacks: IAiFallbackEntry[] = [...(persistedConfig.fallbacks ?? [])];
    const nextFallbacks: IAiFallbackEntry[] = existingFallbacks
      .filter((entry: IAiFallbackEntry): boolean => entry.provider !== provider);

    const nextConfig: IAiConfig = {
      ...this._cloneAiConfig(persistedConfig),
      ...(nextFallbacks.length > 0 ? { fallbacks: nextFallbacks } : { fallbacks: undefined }),
    };

    await this._persistAiConfigAsync(nextConfig);
  }

  public async swapPrimaryWithFirstFallbackAsync(): Promise<IProviderCapabilitySummary> {
    const persistedConfig: IAiConfig = this._getPersistedAiConfig();
    const fallbacks: IAiFallbackEntry[] = [...(persistedConfig.fallbacks ?? [])];

    if (fallbacks.length === 0) {
      throw new Error("No fallback provider configured to swap with primary.");
    }

    const firstFallback: IAiFallbackEntry = fallbacks[0];
    const remainingFallbacks: IAiFallbackEntry[] = fallbacks.slice(1);

    this._ensureProviderConfigured(persistedConfig, firstFallback.provider);

    const previousPrimary: AiProvider = persistedConfig.provider;
    const previousPrimaryModel: string = this._getProviderModelFromConfig(persistedConfig, previousPrimary);

    const swappedConfig: IAiConfig = this._cloneAiConfig(persistedConfig);
    swappedConfig.provider = firstFallback.provider;

    if (firstFallback.model) {
      this._setProviderModelInConfig(swappedConfig, firstFallback.provider, firstFallback.model);
    }

    swappedConfig.fallbacks = [
      {
        provider: previousPrimary,
        model: previousPrimaryModel,
      },
      ...remainingFallbacks,
    ];

    await this.initializeAsync(swappedConfig, {
      persistAsPrimary: true,
      resetFallbackState: true,
    });

    await this._persistAiConfigAsync(swappedConfig);

    return {
      provider: this.getActiveProvider(),
      model: this.getActiveModelId(),
      supportsStructuredOutputs: this.getSupportsStructuredOutputs(),
      supportsToolCalling: this.getSupportsToolCalling(),
      supportsVision: this.getSupportsVision(),
      contextWindow: this.getContextWindow(),
      structuredOutputMode: this.getStructuredOutputMode(),
    };
  }

  public async activateNextFallbackProviderAsync(): Promise<IProviderCapabilitySummary | null> {
    if (!this._primaryProvider) {
      throw new Error("AiProviderService not initialized");
    }

    const persistedConfig: IAiConfig = this._getPersistedAiConfig();
    const fallbacks: IAiFallbackEntry[] = persistedConfig.fallbacks ?? [];

    while (this._fallbackCursor < fallbacks.length) {
      const nextEntry: IAiFallbackEntry = fallbacks[this._fallbackCursor];
      this._fallbackCursor++;

      try {
        this._ensureProviderConfigured(persistedConfig, nextEntry.provider);
        const runtimeConfig: IAiConfig = this._buildRuntimeConfigForProvider(nextEntry.provider, nextEntry.model);

        await this.initializeAsync(runtimeConfig, {
          persistAsPrimary: false,
          resetFallbackState: false,
        });

        this._activeFallbackModelOverride = nextEntry.model ?? null;

        return {
          provider: this.getActiveProvider(),
          model: this.getActiveModelId(),
          supportsStructuredOutputs: this.getSupportsStructuredOutputs(),
          supportsToolCalling: this.getSupportsToolCalling(),
          supportsVision: this.getSupportsVision(),
          contextWindow: this.getContextWindow(),
          structuredOutputMode: this.getStructuredOutputMode(),
        };
      } catch (error: unknown) {
        LoggerService.getInstance().warn("Failed to activate fallback provider", {
          provider: nextEntry.provider,
          model: nextEntry.model,
          error: extractErrorMessage(error),
        });
      }
    }

    return null;
  }

  public async resetToPrimaryProviderAsync(): Promise<boolean> {
    if (!this._primaryProvider || !this._persistedAiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    const shouldResetRuntimeProvider: boolean =
      this._activeRuntimeProvider !== this._primaryProvider ||
      this._activeFallbackModelOverride !== null;

    this._fallbackCursor = 0;
    this._activeFallbackModelOverride = null;

    if (!shouldResetRuntimeProvider) {
      return false;
    }

    const runtimeConfig: IAiConfig = this._buildRuntimeConfigForProvider(this._primaryProvider);
    await this.initializeAsync(runtimeConfig, {
      persistAsPrimary: false,
      resetFallbackState: false,
    });

    return true;
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

  public getGenerationTimeoutFloorMs(): number {
    const configuredTimeout: number | undefined = this._aiConfig?.generationTimeoutMs;
    return Math.max(configuredTimeout ?? MIN_GENERATION_TIMEOUT_FLOOR_MS, MIN_GENERATION_TIMEOUT_FLOOR_MS);
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

  public getSupportsVision(): boolean {
    return this._supportsVision;
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
}
