import { type LanguageModel, wrapLanguageModel, extractReasoningMiddleware } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LMStudioClient } from "@lmstudio/sdk";
import fs from "node:fs/promises";
import path from "node:path";

import { LoggerService } from "../logger.service.js";
import { SchedulerService } from "../scheduler.service.js";
import type {
  IAiConfig,
  AiProvider,
  IRateLimitConfig,
  IOpenRouterConfig,
  IOpenAiCompatibleConfig,
  ILmStudioConfig,
  IProviderModelListEntry,
  IProviderCapabilitySummary,
  ResolvedStructuredOutputMode,
  StructuredOutputMode,
  ILlmResponse,
  ILlmToolCall,
} from "../../shared/types/index.js";
import { RateLimiterService } from "../rate-limiter.service.js";
import { ModelInfoService } from "../model-info.service.js";
import {
  ModelProfileService,
  type IRequestBehaviorProfile,
  type ModelProfileOperation,
} from "../model-profile.service.js";
import { countRequestBodyTokens, type IRequestTokenBreakdown } from "../../utils/request-token-counter.js";
import { extractErrorMessage } from "../../utils/error.js";
import { getCurrentLlmCallType } from "../../utils/llm-call-context.js";
import { runToolCallingProbeAsync } from "../../utils/llm-probe-helpers.js";
import { createHash } from "node:crypto";
import { ensureDirectoryExistsAsync, getCacheDir } from "../../utils/paths.js";
import { ConfigService } from "../config.service.js";
import { HARD_GATE_THRESHOLD_PERCENTAGE } from "../../shared/constants.js";

interface IOpenRouterModelListEntry {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface IOpenRouterModelListResponse {
  data?: IOpenRouterModelListEntry[];
}

interface IOpenAiCompatibleModelListEntry {
  id: string;
}

interface IOpenAiCompatibleModelListResponse {
  data?: IOpenAiCompatibleModelListEntry[];
}

function normalizeBaseUrl(url: string): string {
  const trimmed: string = url.trim();
  return trimmed.replace(/\/v1\/?$/, "");
}

const LM_STUDIO_MODEL_RECOVERY_RETRIES: number = 3;
const CAPABILITY_PROBE_TIMEOUT_MS: number = 300_000;
const PARALLEL_TOOL_CALL_PROBE_TIMEOUT_MS: number = CAPABILITY_PROBE_TIMEOUT_MS;
export const MIN_GENERATION_TIMEOUT_FLOOR_MS: number = 600_000;
export const DEFAULT_REQUEST_TIMEOUT_MS: number = 600_000; // 600 seconds (10 minutes)
export const REQUEST_TIMEOUT_RETRY_MULTIPLIER: number = 2;
const REQUEST_TIMEOUT_MAX_ATTEMPTS: number = 2; // initial + 1 retry
const OPENROUTER_FREE_MODEL_RPM_LIMIT: number = 20;
const VISION_PROBE_TIMEOUT_MS: number = CAPABILITY_PROBE_TIMEOUT_MS;
const TOOL_CALLING_PROBE_TIMEOUT_MS: number = CAPABILITY_PROBE_TIMEOUT_MS;
const VISION_PROBE_MAX_TOKENS: number = 128;
const CAPABILITY_CACHE_FILE_NAME: string = "capabilities.json";
const tinyProbePngBase64: string = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR4nO3NMQ0AAAwDoPpXWSlVsWMJGCA9FoFAIBAIBAKBQPAlGMclgJeVJrNbAAAAAElFTkSuQmCC";

export const STRUCTURED_OUTPUT_STRATEGY_AUTO: StructuredOutputMode = "auto";

export interface ICapabilityCacheEntry {
  supportsVision?: boolean;
  supportsReasoningFormat?: boolean;
  supportsStructuredOutputs?: boolean;
  supportsToolCalling?: boolean;
  supportsParallelToolCalls?: boolean;
  resolvedStructuredOutputMode?: ResolvedStructuredOutputMode;
  responseFormatOk?: boolean;
  responseFormatReason?: string;
  detectedAt: string;
  method?: "api" | "probe";
}

export type ICapabilityCache = Record<string, ICapabilityCacheEntry>;


export class AiProviderCore {
  //#region Data members

  protected _aiConfig: IAiConfig | null;
  protected _rateLimiterService: RateLimiterService;
  protected _modelInfoService: ModelInfoService;
  protected _modelProfileService: ModelProfileService;
  protected _defaultModel: LanguageModel | null;
  protected _contextWindow: number;
  protected _supportsStructuredOutputs: boolean = false;
  protected _supportsReasoningFormat: boolean = false;
  protected _supportsParallelToolCalls: boolean = false;
  protected _supportsToolCalling: boolean = true;
  protected _supportsVision: boolean = false;
  protected _resolvedStructuredOutputMode: ResolvedStructuredOutputMode = "native_json_schema";
  protected _requestTimeoutMs: number;
  protected _activeProfileName: string | null;
  protected _llmResponseDiagnosticsEnabled: boolean;
  protected _persistedAiConfig: IAiConfig | null;
  protected _primaryProvider: AiProvider | null;
  protected _activeRuntimeProvider: AiProvider | null;
  protected _activeFallbackModelOverride: string | null;
  protected _fallbackCursor: number;

  //#endregion Data members

  //#region Constructors

  protected constructor() {
    this._aiConfig = null;
    this._rateLimiterService = RateLimiterService.getInstance();
    this._modelInfoService = ModelInfoService.getInstance();
    this._modelProfileService = ModelProfileService.getInstance();
    this._defaultModel = null;
    this._contextWindow = 128000; // Default context window
    this._requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    this._activeProfileName = null;
    this._llmResponseDiagnosticsEnabled = false;
    this._persistedAiConfig = null;
    this._primaryProvider = null;
    this._activeRuntimeProvider = null;
    this._activeFallbackModelOverride = null;
    this._fallbackCursor = 0;
  }

  //#endregion Constructors

  public async listModelsAsync(
    provider: AiProvider,
    filter?: string,
    includeUnknownToolSupport: boolean = false,
  ): Promise<IProviderModelListEntry[]> {
    if (provider === "openrouter") {
      return this._listOpenRouterModelsAsync(filter);
    }

    return this._listLocalProviderModelsAsync(provider, filter, includeUnknownToolSupport);
  }

  public async probeCapabilitiesForProviderModelAsync(
    provider: AiProvider,
    model: string,
  ): Promise<IProviderCapabilitySummary> {
    const runtimeConfig: IAiConfig = this._buildRuntimeConfigForProvider(provider, model);
    return this._probeCapabilitiesForConfigAsync(runtimeConfig);
  }

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

      // Build probe request body.
      // IMPORTANT: Do not include reasoning_format here. On newer llama.cpp
      // versions, combining reasoning_format with response_format json_schema
      // can fail (e.g. sampler initialization errors), even when each feature
      // works independently.
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

      // If the endpoint returned structured-output related hard errors, treat
      // this as unsupported instead of retrying parse attempts.
      // This specifically helps llama.cpp variants that can emit endpoint-level
      // JSON-schema parser/sampler errors.
      const responseErrorMessage: string =
        typeof (json as Record<string, unknown>).error === "object" &&
          (json as Record<string, unknown>).error !== null &&
          typeof ((json as Record<string, unknown>).error as Record<string, unknown>).message === "string"
          ? (((json as Record<string, unknown>).error as Record<string, unknown>).message as string)
          : "";

      if (responseErrorMessage.length > 0) {
        logger.debug("Structured output probe: endpoint returned structured-output error payload", {
          message: responseErrorMessage.substring(0, 200),
        });
        return false;
      }
      const candidates: string[] = [
        message?.content ?? "",
        message?.reasoning_content ?? "",
      ].filter((s: string): boolean => s.length > 0);

      for (const candidate of candidates) {
        // Strip think tags that some models wrap around their output
        const stripped: string = candidate
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .replace(/<\|channel>thought\n[\s\S]*?\n<channel\|>/g, "")
          .trim();
        const textToParse: string = stripped.length > 0 ? stripped : candidate;

        try {
          const parsed = JSON.parse(textToParse) as Record<string, unknown>;
          const isValid: boolean = typeof parsed.ok === "boolean";
          if (isValid) {
            logger.info("Structured output probe result: SUPPORTED");
            return true;
          }
   } catch (e: unknown) {
        if (!(e instanceof SyntaxError)) throw e;
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

  protected _cloneAiConfig(aiConfig: IAiConfig): IAiConfig {
    return structuredClone(aiConfig);
  }

  protected _getPersistedAiConfig(): IAiConfig {
    if (!this._persistedAiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    return this._cloneAiConfig(this._persistedAiConfig);
  }

  protected async _persistAiConfigAsync(aiConfig: IAiConfig): Promise<void> {
    const configService: ConfigService = ConfigService.getInstance();
    await configService.updateConfigAsync({ ai: aiConfig });
    this._persistedAiConfig = this._cloneAiConfig(aiConfig);
  }

  protected _getProviderConfigFromAiConfig(
    aiConfig: IAiConfig,
    provider: AiProvider,
  ): IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig {
    if (provider === "openrouter") {
      if (!aiConfig.openrouter) {
        throw new Error("OpenRouter provider is not configured.");
      }
      return aiConfig.openrouter;
    }

    if (provider === "openai-compatible") {
      if (!aiConfig.openaiCompatible) {
        throw new Error("OpenAI-compatible provider is not configured.");
      }
      return aiConfig.openaiCompatible;
    }

    if (!aiConfig.lmStudio) {
      throw new Error("LM Studio provider is not configured.");
    }

    return aiConfig.lmStudio;
  }

  protected _ensureProviderConfigured(aiConfig: IAiConfig, provider: AiProvider): void {
    this._getProviderConfigFromAiConfig(aiConfig, provider);
  }

  protected _getProviderModelFromConfig(aiConfig: IAiConfig, provider: AiProvider): string {
    const config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getProviderConfigFromAiConfig(aiConfig, provider);
    return config.model;
  }

  protected _setProviderModelInConfig(aiConfig: IAiConfig, provider: AiProvider, model: string): void {
    const config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getProviderConfigFromAiConfig(aiConfig, provider);
    config.model = model;
  }

  protected _buildRuntimeConfigForProvider(provider: AiProvider, modelOverride?: string): IAiConfig {
    const persistedConfig: IAiConfig = this._getPersistedAiConfig();
    this._ensureProviderConfigured(persistedConfig, provider);

    const runtimeConfig: IAiConfig = this._cloneAiConfig(persistedConfig);
    runtimeConfig.provider = provider;

    if (modelOverride && modelOverride.trim().length > 0) {
      this._setProviderModelInConfig(runtimeConfig, provider, modelOverride.trim());
    }

    return runtimeConfig;
  }

  protected _buildProviderAuthHeaders(
    provider: AiProvider,
    config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider === "openrouter") {
      headers.Authorization = `Bearer ${(config as IOpenRouterConfig).apiKey}`;
      return headers;
    }

    const apiKey: string | undefined = (config as IOpenAiCompatibleConfig | ILmStudioConfig).apiKey;
    if (apiKey && apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
  }

  protected async _listOpenRouterModelsAsync(filter?: string): Promise<IProviderModelListEntry[]> {
    const filterNeedle: string = (filter ?? "").trim().toLowerCase();

    const response: Response = await fetch(
      "https://openrouter.ai/api/v1/models?supported_parameters=tools",
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`OpenRouter model listing failed (${response.status} ${response.statusText}).`);
    }

    const parsed: IOpenRouterModelListResponse = await response.json() as IOpenRouterModelListResponse;
    const data: IOpenRouterModelListEntry[] = Array.isArray(parsed.data) ? parsed.data : [];

    const rows: IProviderModelListEntry[] = data
      .map((entry: IOpenRouterModelListEntry): IProviderModelListEntry => {
        const supportedParams: string[] = Array.isArray(entry.supported_parameters)
          ? entry.supported_parameters.map((param: string): string => param.toLowerCase())
          : [];

        const supportsTools: boolean = supportedParams.includes("tools");

        return {
          id: entry.id,
          name: entry.name ?? entry.id,
          contextWindow: typeof entry.context_length === "number" ? entry.context_length : null,
          supportsTools,
          promptPrice: entry.pricing?.prompt ?? null,
          completionPrice: entry.pricing?.completion ?? null,
        };
      })
      .filter((entry: IProviderModelListEntry): boolean => entry.supportsTools === true)
      .filter((entry: IProviderModelListEntry): boolean => {
        if (filterNeedle.length === 0) {
          return true;
        }

        const haystack: string = `${entry.id} ${entry.name}`.toLowerCase();
        return haystack.includes(filterNeedle);
      })
      .sort((left: IProviderModelListEntry, right: IProviderModelListEntry): number =>
        left.id.localeCompare(right.id),
      );

    return rows;
  }

  protected async _listLocalProviderModelsAsync(
    provider: AiProvider,
    filter?: string,
    includeUnknownToolSupport: boolean = false,
  ): Promise<IProviderModelListEntry[]> {
    const persistedConfig: IAiConfig = this._getPersistedAiConfig();
    const config: IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getProviderConfigFromAiConfig(persistedConfig, provider) as IOpenAiCompatibleConfig | ILmStudioConfig;
    const baseUrl: string = this._getLocalBaseUrl(config);
    const headers: Record<string, string> = this._buildProviderAuthHeaders(provider, config);

    const response: Response = await fetch(`${baseUrl}/v1/models`, {
      headers,
    });

    if (!response.ok) {
      throw new Error(`Model listing failed for ${provider} (${response.status} ${response.statusText}).`);
    }

    const parsed: IOpenAiCompatibleModelListResponse = await response.json() as IOpenAiCompatibleModelListResponse;
    const modelEntries: IOpenAiCompatibleModelListEntry[] = Array.isArray(parsed.data) ? parsed.data : [];
    const filterNeedle: string = (filter ?? "").trim().toLowerCase();

    const filteredIds: string[] = modelEntries
      .map((entry: IOpenAiCompatibleModelListEntry): string => entry.id)
      .filter((id: string): boolean => id.trim().length > 0)
      .filter((id: string): boolean => {
        if (filterNeedle.length === 0) {
          return true;
        }

        return id.toLowerCase().includes(filterNeedle);
      });

    const maxProbeModels: number = filterNeedle.length > 0 ? filteredIds.length : Math.min(filteredIds.length, 40);
    const supportMap: Map<string, boolean | null> = new Map<string, boolean | null>();

    for (let i: number = 0; i < filteredIds.length; i++) {
      const modelId: string = filteredIds[i];
      if (i >= maxProbeModels) {
        supportMap.set(modelId, null);
        continue;
      }

      try {
        const supportsTools: boolean = await this._probeToolCallingForProviderModelAsync(provider, config, modelId);
        supportMap.set(modelId, supportsTools);
      } catch (e: unknown) {
        supportMap.set(modelId, null);
      }
    }

    return filteredIds
      .map((modelId: string): IProviderModelListEntry => ({
        id: modelId,
        name: modelId,
        contextWindow: null,
        supportsTools: supportMap.get(modelId) ?? null,
        promptPrice: null,
        completionPrice: null,
      }))
      .filter((entry: IProviderModelListEntry): boolean => {
        if (entry.supportsTools === true) {
          return true;
        }

        return includeUnknownToolSupport && entry.supportsTools === null;
      });
  }

  protected async _probeCapabilitiesForConfigAsync(runtimeConfig: IAiConfig): Promise<IProviderCapabilitySummary> {
    const provider: AiProvider = runtimeConfig.provider;
    const model: string = this._getProviderModelFromConfig(runtimeConfig, provider);

    if (provider === "openrouter") {
      const supportedParameters: Set<string> | null = await this._modelInfoService.fetchSupportedParametersAsync(model);
      const supportsImages: boolean | null = await this._modelInfoService.fetchSupportsImagesAsync(model);
      const contextWindow: number = await this._modelInfoService.fetchContextWindowAsync(model);

      const hasStructuredOutputs: boolean = supportedParameters?.has("structured_outputs") === true ||
        supportedParameters?.has("response_format") === true;
      const hasTools: boolean = supportedParameters?.has("tools") === true;
      const hasToolChoice: boolean = supportedParameters?.has("tool_choice") === true;

      const mode: ResolvedStructuredOutputMode = hasStructuredOutputs
        ? "native_json_schema"
        : hasTools && hasToolChoice
          ? "tool_emulated"
          : "tool_auto";

      return {
        provider,
        model,
        supportsStructuredOutputs: hasStructuredOutputs,
        supportsToolCalling: hasTools,
        supportsVision: supportsImages === true,
        contextWindow,
        structuredOutputMode: mode,
      };
    }

    const config: IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getProviderConfigFromAiConfig(runtimeConfig, provider) as IOpenAiCompatibleConfig | ILmStudioConfig;

    const supportsStructuredOutputs: boolean = await this._probeStructuredOutputsForProviderModelAsync(provider, config, model);
    const supportsToolCalling: boolean = await this._probeToolCallingForProviderModelAsync(provider, config, model);
    const supportsVision: boolean = await this._probeVisionSupportForProviderModelAsync(provider, config, model);
    const mode: ResolvedStructuredOutputMode = supportsStructuredOutputs
      ? "native_json_schema"
      : supportsToolCalling
        ? "tool_emulated"
        : "tool_auto";

    return {
      provider,
      model,
      supportsStructuredOutputs,
      supportsToolCalling,
      supportsVision,
      contextWindow: config.contextWindow ?? 32768,
      structuredOutputMode: mode,
    };
  }

  protected async _probeToolCallingForProviderModelAsync(
    provider: AiProvider,
    config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig,
    modelId: string,
  ): Promise<boolean> {
    if (provider === "openrouter") {
      const probeResult = await runToolCallingProbeAsync({
        url: "https://openrouter.ai/api/v1/chat/completions",
        model: modelId,
        prompt: "Call the tool once.",
        toolChoice: "required",
        maxTokens: 40,
        timeoutMs: TOOL_CALLING_PROBE_TIMEOUT_MS,
        apiKey: (config as IOpenRouterConfig).apiKey,
        providerPayload: {
          require_parameters: true,
        },
      });

      return probeResult.ok && probeResult.hasToolCalls;
    }

    const probeResult = await runToolCallingProbeAsync({
      url: `${this._getLocalBaseUrl(config)}/v1/chat/completions`,
      model: modelId,
      prompt: "Call the tool once.",
      toolChoice: "required",
      maxTokens: 40,
      timeoutMs: TOOL_CALLING_PROBE_TIMEOUT_MS,
      apiKey: (config as IOpenAiCompatibleConfig | ILmStudioConfig).apiKey,
    });

    return probeResult.ok && probeResult.hasToolCalls;
  }

  protected async _probeStructuredOutputsForProviderModelAsync(
    provider: AiProvider,
    config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig,
    modelId: string,
  ): Promise<boolean> {
    const endpointUrl: string = provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : `${this._getLocalBaseUrl(config)}/v1/chat/completions`;
    const headers: Record<string, string> = this._buildProviderAuthHeaders(provider, config);

    const probeBody: Record<string, unknown> = {
      model: modelId,
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

    const response: Response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(probeBody),
    });

    if (!response.ok) {
      return false;
    }

    const parsed: ILlmResponse = await response.json() as ILlmResponse;
    const message = parsed.choices?.[0]?.message;
    const candidate: string = (message?.content ?? message?.reasoning_content ?? "").trim();

    if (candidate.length === 0) {
      return false;
    }

    try {
      const payload = JSON.parse(candidate) as Record<string, unknown>;
      return typeof payload.ok === "boolean";
    } catch (e: unknown) {
      if (!(e instanceof SyntaxError)) throw e;
      return false;
    }
  }

  protected async _probeVisionSupportForProviderModelAsync(
    provider: AiProvider,
    config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig,
    modelId: string,
  ): Promise<boolean> {
    const endpointUrl: string = provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : `${this._getLocalBaseUrl(config)}/v1/chat/completions`;
    const headers: Record<string, string> = this._buildProviderAuthHeaders(provider, config);

    const controller: AbortController = new AbortController();
    const timeoutId: NodeJS.Timeout = setTimeout((): void => {
      controller.abort();
    }, VISION_PROBE_TIMEOUT_MS);

    const probeBody: Record<string, unknown> = {
      model: modelId,
      max_tokens: VISION_PROBE_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in one short sentence." },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${tinyProbePngBase64}`,
              },
            },
          ],
        },
      ],
    };

    if (provider !== "openrouter" && this._supportsReasoningFormat) {
      probeBody.reasoning_format = "none";
    }

    try {
      const response: Response = await fetch(endpointUrl, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(probeBody),
      });

      if (!response.ok) {
        return false;
      }

      const parsed: ILlmResponse = await response.json() as ILlmResponse;
      const message = parsed.choices?.[0]?.message;
      const candidate: string = this._resolveBestProbeCandidate(message);
      return candidate.length > 0;
    } catch (e: unknown) {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fixes responses where content is in reasoning_content instead of content.
   * Logs a warning and copies reasoning_content to content.
   *
   * Important: for tool-call responses, keep reasoning_content separate so the
   * AI SDK can round-trip it in history as reasoning_content (client-side
   * think-tag extraction flow).
   */
  protected async _fixReasoningContentResponse(response: Response): Promise<Response> {
    if (!response.ok) return response;

    try {
      const logger: LoggerService = LoggerService.getInstance();
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

        const gemmaChannelRegex: RegExp = /<\|channel>thought\n([\s\S]*?)\n<channel\|>([\s\S]*?)$/g;
        const gemmaMatches: RegExpMatchArray[] = Array.from(originalContent.matchAll(gemmaChannelRegex));

        if (gemmaMatches.length > 0) {
          const reasoningParts: string[] = gemmaMatches
            .map((match: RegExpMatchArray): string => (match[1] ?? "").trim())
            .filter((part: string): boolean => part.length > 0);

          const cleanedContent: string = originalContent
            .replace(/<\|channel>thought\n[\s\S]*?\n<channel\|>/g, "")
            .trim();

          return {
            reasoningContent: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : null,
            cleanedContent,
          };
        }

        const gemmaChannelOpen: string = "<|channel>thought";
        const gemmaChannelOpenIndex: number = originalContent.indexOf(gemmaChannelOpen);

        if (gemmaChannelOpenIndex !== -1) {
          const afterOpen: string = originalContent
            .slice(gemmaChannelOpenIndex + gemmaChannelOpen.length)
            .trim();
          const channelClose: string = "<channel|>";
          const channelCloseIndex: number = afterOpen.indexOf(channelClose);

          if (channelCloseIndex !== -1) {
            const reasoningContent: string = afterOpen
              .slice(0, channelCloseIndex)
              .trim();
            const cleanedContent: string = afterOpen
              .slice(channelCloseIndex + channelClose.length)
              .trim();

            return {
              reasoningContent: reasoningContent.length > 0 ? reasoningContent : null,
              cleanedContent,
            };
          }
        }

        return {
          reasoningContent: null,
          cleanedContent: originalContent,
        };
      };

      const json = await response.clone().json() as ILlmResponse;

      if (json.choices && Array.isArray(json.choices)) {
        let modified = false;
        let choicesWithReasoning: number = 0;
        let choicesWithThinkTags: number = 0;
        let totalThinkTagCount: number = 0;
        let choicesWithReasoningContentField: number = 0;

        for (const choice of json.choices) {
          const hasReasoningContent = choice.message?.reasoning_content;
          const hasEmptyContent = !choice.message?.content || choice.message.content === "";
          const hasToolCalls =
            Array.isArray(choice.message?.tool_calls) &&
            choice.message.tool_calls.length > 0;

          const rawContent: string | undefined = choice.message?.content;
          const reasoningContent: string = typeof choice.message?.reasoning_content === "string"
            ? choice.message.reasoning_content
            : "";

          const thinkTagMatches: RegExpMatchArray[] = typeof rawContent === "string"
            ? Array.from(rawContent.matchAll(/<think>[\s\S]*?<\/think>/g))
            : [];
          const hasThinkBoundary: boolean =
            typeof rawContent === "string" &&
            (thinkTagMatches.length > 0 || rawContent.includes("</think>"));
          const hasReasoningField: boolean = reasoningContent.trim().length > 0;

          const gemmaChannelMatches: RegExpMatchArray[] = typeof rawContent === "string"
            ? Array.from(rawContent.matchAll(/<\|channel>thought[\s\S]*?<channel\|>/g))
            : [];
          const hasGemmaChannelTags: boolean = gemmaChannelMatches.length > 0;

          if (thinkTagMatches.length > 0) {
            choicesWithThinkTags += 1;
            totalThinkTagCount += thinkTagMatches.length;
          }

          if (hasReasoningField) {
            choicesWithReasoningContentField += 1;
          }

          if (hasReasoningField || hasThinkBoundary || hasGemmaChannelTags) {
            choicesWithReasoning += 1;
          }

          if (this._llmResponseDiagnosticsEnabled && typeof rawContent === "string") {
            if (thinkTagMatches.length > 0) {
              logger.debug("Detected think tags in LLM response", {
                thinkTagCount: thinkTagMatches.length,
                hasToolCalls,
                contentLength: rawContent.length,
                reasoningContentLength: reasoningContent.trim().length,
                contentPreview: rawContent.slice(0, 200),
              });
            }
            if (hasGemmaChannelTags) {
              logger.debug("Detected Gemma channel tags in LLM response", {
                gemmaChannelCount: gemmaChannelMatches.length,
                hasToolCalls,
                contentLength: rawContent.length,
                reasoningContentLength: reasoningContent.trim().length,
                contentPreview: rawContent.slice(0, 200),
              });
            }
          }

          if (this._llmResponseDiagnosticsEnabled && hasEmptyContent && reasoningContent.trim().length > 0) {
            logger.debug("Detected reasoning_content without visible content in LLM response", {
              hasToolCalls,
              reasoningContentLength: reasoningContent.trim().length,
              reasoningPreview: reasoningContent.slice(0, 200),
            });
          }

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

          if (!hasToolCalls && hasGemmaChannelTags && typeof rawContent === "string" && rawContent.trim().length > 0) {
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

        if (choicesWithReasoning > 0) {
          logger.info("Detected reasoning in LLM response", {
            choicesCount: json.choices.length,
            choicesWithReasoning,
            choicesWithThinkTags,
            totalThinkTagCount,
            choicesWithReasoningContentField,
          });
        }

        if (modified) {
          return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      }
  } catch (e: unknown) {
          if (!(e instanceof SyntaxError)) throw e;
        }

    return response;
  }

  protected async _resolveStructuredOutputModeAsync(
    defaultModelId: string,
    logger: LoggerService,
    capabilityCacheKey: string,
  ): Promise<void> {
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

    const cachedEntry: ICapabilityCacheEntry | null = await this._readCapabilityCacheEntryAsync(capabilityCacheKey);
    const cachedMode: ResolvedStructuredOutputMode | undefined = cachedEntry?.resolvedStructuredOutputMode;
    const cachedSupportsStructured: boolean | undefined = cachedEntry?.supportsStructuredOutputs;
    const cachedSupportsTools: boolean | undefined = cachedEntry?.supportsToolCalling;
    const canUseCachedMode: boolean =
      (cachedMode === "native_json_schema" && cachedSupportsStructured === true && cachedSupportsTools === true) ||
      ((cachedMode === "tool_emulated" || cachedMode === "tool_auto") && cachedSupportsTools === true);

    if (canUseCachedMode && cachedMode) {
      this._resolvedStructuredOutputMode = cachedMode;
      this._supportsStructuredOutputs = cachedSupportsStructured === true;
      this._supportsToolCalling = cachedSupportsTools === true;
      logger.info("Structured output mode loaded from cache", {
        provider: providerKey,
        model: defaultModelId,
        mode: this._resolvedStructuredOutputMode,
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        source: "capability_cache",
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
          await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
            supportsStructuredOutputs: this._supportsStructuredOutputs,
            supportsToolCalling: this._supportsToolCalling,
            resolvedStructuredOutputMode: this._resolvedStructuredOutputMode,
          });
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
          await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
            supportsStructuredOutputs: this._supportsStructuredOutputs,
            supportsToolCalling: this._supportsToolCalling,
            resolvedStructuredOutputMode: this._resolvedStructuredOutputMode,
          });
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
          await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
            supportsStructuredOutputs: this._supportsStructuredOutputs,
            supportsToolCalling: this._supportsToolCalling,
            resolvedStructuredOutputMode: this._resolvedStructuredOutputMode,
          });
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
      await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        resolvedStructuredOutputMode: this._resolvedStructuredOutputMode,
      });
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
      await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        resolvedStructuredOutputMode: this._resolvedStructuredOutputMode,
      });
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
      await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        resolvedStructuredOutputMode: this._resolvedStructuredOutputMode,
      });
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

    if (this._supportsReasoningFormat) {
      // Compatibility fallback for newer llama.cpp builds where thinking/
      // reasoning features can interfere with structured-output/tool probes,
      // even though regular tool-calling works at runtime.
      this._supportsStructuredOutputs = false;
      this._supportsToolCalling = true;
      this._resolvedStructuredOutputMode = "tool_auto";
      await this._writeCapabilityCacheEntryAsync(capabilityCacheKey, {
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        resolvedStructuredOutputMode: this._resolvedStructuredOutputMode,
      });
      logger.warn("Structured output probes failed, falling back to tool_auto due to reasoning_format support", {
        provider: providerKey,
        model: defaultModelId,
        mode: this._resolvedStructuredOutputMode,
        supportsStructuredOutputs: this._supportsStructuredOutputs,
        supportsToolCalling: this._supportsToolCalling,
        source: "probe:fallback_reasoning_format",
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
  protected async _testReasoningFormatSupportAsync(): Promise<boolean> {
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
  protected async _testParallelToolCallSupportAsync(): Promise<boolean> {
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
          prompt: "Call the tool emit_probe once with ok:true. Use the tool, do not explain.",
          toolChoice: "required",
          maxTokens: 200,
          timeoutMs: TOOL_CALLING_PROBE_TIMEOUT_MS,
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
        prompt: "Call the tool emit_probe once with ok:true. Use the tool, do not explain.",
        toolChoice: "required",
        maxTokens: 200,
        timeoutMs: TOOL_CALLING_PROBE_TIMEOUT_MS,
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
          prompt: "Call the tool emit_probe once with ok:true. Use the tool, do not explain.",
          toolChoice: "auto",
          maxTokens: 200,
          timeoutMs: TOOL_CALLING_PROBE_TIMEOUT_MS,
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
        prompt: "Call the tool emit_probe once with ok:true. Use the tool, do not explain.",
        toolChoice: "auto",
        maxTokens: 200,
        timeoutMs: TOOL_CALLING_PROBE_TIMEOUT_MS,
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
  protected async _ensureModelLoadedAsync(): Promise<void> {
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

  protected _wrapModelWithRateLimiter(model: LanguageModel, providerKey: string): LanguageModel {
    const originalModel = model as LanguageModelV3;

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

    return wrappedModel as LanguageModel;
  }

  /**
   * Creates a fetch wrapper that:
   * 1. Counts tokens of every POST request body (actual serialized size, not estimated).
   * 2. Logs the breakdown (messages / tools / system / overhead / utilization).
   * 3. Rejects requests whose total tokens exceed the hard gate (85% of context window)
   *    by returning a synthetic 400 "context_length_exceeded" response — this triggers
   *    the existing compaction-retry logic in BaseAgentBase.processMessageAsync.
   */
  protected _createTokenGatedFetch(providerName: string): typeof fetch {
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
          image: tokenBreakdown.image,
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
          const timeoutMs: number = this._requestTimeoutMs * REQUEST_TIMEOUT_RETRY_MULTIPLIER ** timeoutAttempt;
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
              } catch (e: unknown) {
                if (!(e instanceof SyntaxError)) throw e;
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

  protected _createModel(modelId: string): LanguageModel {
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
              const body = JSON.parse(init.body) as Record<string, unknown>;
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

              if (modified) {
                init.body = JSON.stringify(body);
              }
            } catch (e: unknown) {
              // Ignore parse/type errors — request body is unchanged
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
              const body = JSON.parse(init.body) as Record<string, unknown>;
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
            } catch (e: unknown) {
              // Ignore parse/type errors — request body is unchanged
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

  protected _getActiveModelId(): string {
    const config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig =
      this._getActiveProviderConfig();

    return config.model;
  }

  protected _getLocalBaseUrl(config: IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig): string {
    return normalizeBaseUrl((config as IOpenAiCompatibleConfig | ILmStudioConfig).baseUrl || "http://localhost:1234");
  }

  protected _isOpenRouter(providerKey: AiProvider): boolean {
    return providerKey === "openrouter";
  }

  protected _isOpenAiCompatible(providerKey: AiProvider): boolean {
    return providerKey === "openai-compatible";
  }

  protected _isLmStudio(providerKey: AiProvider): boolean {
    return providerKey === "lm-studio";
  }

  protected _isLocalProvider(providerKey: AiProvider): boolean {
    return this._isOpenAiCompatible(providerKey) || this._isLmStudio(providerKey);
  }

  protected _resolveEffectiveRateLimits(
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

  protected _getActiveProviderConfig():
    | IOpenRouterConfig
    | IOpenAiCompatibleConfig
    | ILmStudioConfig {
    if (!this._aiConfig) {
      throw new Error("AiProviderService not initialized");
    }

    return this._getProviderConfigFromAiConfig(this._aiConfig, this._aiConfig.provider);
  }

  protected _getLargestComponent(breakdown: IRequestTokenBreakdown): string {
    const components = [
      { name: 'messages', value: breakdown.messages },
      { name: 'image', value: breakdown.image },
      { name: 'tools', value: breakdown.tools },
      { name: 'system', value: breakdown.system },
      { name: 'overhead', value: breakdown.overhead },
    ];
    const largest = components.reduce((max, comp) => comp.value > max.value ? comp : max);
    return `${largest.name} (${largest.value} tokens)`;
  }

  protected _resolveRequestBehaviorForCurrentCall(): IRequestBehaviorProfile {
    if (!this._activeProfileName) {
      return {};
    }

    try {
      const currentCallType = getCurrentLlmCallType();
      const operation: ModelProfileOperation = currentCallType ?? "agent_primary";
      const behavior: IRequestBehaviorProfile | null =
        this._modelProfileService.resolveRequestBehavior(this._activeProfileName, operation);

      return behavior ?? {};
    } catch (e: unknown) {
      return {};
    }
  }

  protected async _resolveVisionSupportAsync(defaultModelId: string, logger: LoggerService): Promise<void> {
    if (!this._aiConfig) {
      this._supportsVision = false;
      return;
    }

    const providerKey: AiProvider = this._aiConfig.provider;

    if (this._isOpenRouter(providerKey)) {
      const supportsImagesFromApi: boolean | null = await this._modelInfoService.fetchSupportsImagesAsync(defaultModelId);
      if (supportsImagesFromApi !== null) {
        this._supportsVision = supportsImagesFromApi;
        logger.info("Vision support resolved from OpenRouter metadata", {
          provider: providerKey,
          model: defaultModelId,
          supportsVision: this._supportsVision,
          source: "openrouter_model_metadata",
        });
        return;
      }
    }

    const cacheKey: string = `${providerKey}:${defaultModelId}`;
    const cachedSupport: boolean | null = await this._readVisionSupportCacheEntryAsync(cacheKey);

    if (cachedSupport !== null) {
      if (cachedSupport) {
        this._supportsVision = true;
        logger.info("Vision support loaded from cache", {
          provider: providerKey,
          model: defaultModelId,
          supportsVision: this._supportsVision,
          source: "vision_cache",
        });
        return;
      }

      logger.info("Vision cache indicates unsupported; re-probing to avoid stale false negatives", {
        provider: providerKey,
        model: defaultModelId,
        source: "vision_cache",
      });
    }

    const probeResult: boolean = await this._probeVisionSupportAsync();
    this._supportsVision = probeResult;

    await this._writeVisionSupportCacheEntryAsync(cacheKey, probeResult, this._isOpenRouter(providerKey) ? "api" : "probe");

    logger.info("Vision support resolved by probe", {
      provider: providerKey,
      model: defaultModelId,
      supportsVision: this._supportsVision,
      source: "vision_probe",
    });
  }

  protected async _probeVisionSupportAsync(): Promise<boolean> {
    if (!this._aiConfig) {
      return false;
    }

    const config = this._getActiveProviderConfig();
    const provider: AiProvider = this._aiConfig.provider;
    const logger: LoggerService = LoggerService.getInstance();

    const endpointUrl: string = provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : `${this._getLocalBaseUrl(config)}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider === "openrouter") {
      headers.Authorization = `Bearer ${(config as IOpenRouterConfig).apiKey}`;
    }

    const controller: AbortController = new AbortController();
    const timeoutId: NodeJS.Timeout = setTimeout((): void => {
      controller.abort();
    }, VISION_PROBE_TIMEOUT_MS);

    const probeBody: Record<string, unknown> = {
      model: config.model,
      max_tokens: VISION_PROBE_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in one short sentence." },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${tinyProbePngBase64}`,
              },
            },
          ],
        },
      ],
    };

    if (provider !== "openrouter" && this._supportsReasoningFormat) {
      probeBody.reasoning_format = "none";
    }

    try {
      const response: Response = await fetch(endpointUrl, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(probeBody),
      });

      if (!response.ok) {
        logger.debug("Vision probe failed with non-OK status", {
          provider,
          status: response.status,
          statusText: response.statusText,
        });
        return false;
      }

      const parsed: ILlmResponse = await response.json() as ILlmResponse;
      const message = parsed.choices?.[0]?.message;
      const candidate: string = this._resolveBestProbeCandidate(message);
      logger.debug("Vision probe response analysis", {
        provider,
        contentLength: (message?.content ?? "").trim().length,
        reasoningContentLength: (message?.reasoning_content ?? "").trim().length,
        candidateLength: candidate.length,
      });
      return candidate.length > 0;
    } catch (error: unknown) {
      logger.debug("Vision probe request failed", {
        provider,
        error: extractErrorMessage(error),
      });
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  protected async _readVisionSupportCacheEntryAsync(cacheKey: string): Promise<boolean | null> {
    const entry: ICapabilityCacheEntry | null = await this._readCapabilityCacheEntryAsync(cacheKey);
    if (!entry || typeof entry.supportsVision !== "boolean") {
      return null;
    }

    return entry.supportsVision;
  }

  protected async _writeVisionSupportCacheEntryAsync(
    cacheKey: string,
    supportsVision: boolean,
    method: "api" | "probe",
  ): Promise<void> {
    await this._writeCapabilityCacheEntryAsync(cacheKey, {
      supportsVision,
      method,
    });
  }

  protected async _readCapabilityCacheEntryAsync(cacheKey: string): Promise<ICapabilityCacheEntry | null> {
    const cache: ICapabilityCache = await this._readCapabilityCacheAsync();
    const entry: ICapabilityCacheEntry | undefined = cache[cacheKey];
    if (!entry || typeof entry !== "object") {
      return null;
    }

    return entry;
  }

  protected async _writeCapabilityCacheEntryAsync(
    cacheKey: string,
    patch: Partial<ICapabilityCacheEntry>,
  ): Promise<void> {
    const cachePath: string = this._getCapabilityCachePath();
    const cacheDir: string = path.dirname(cachePath);
    await ensureDirectoryExistsAsync(cacheDir);

    const cache: ICapabilityCache = await this._readCapabilityCacheAsync();
    const existing: ICapabilityCacheEntry = cache[cacheKey] ?? {
      detectedAt: new Date().toISOString(),
    };

    cache[cacheKey] = {
      ...existing,
      ...patch,
      detectedAt: new Date().toISOString(),
    };

    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  }

  protected async _readCapabilityCacheAsync(): Promise<ICapabilityCache> {
    const cachePath: string = this._getCapabilityCachePath();

    try {
      const content: string = await fs.readFile(cachePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        return parsed as ICapabilityCache;
      }
      return {};
    } catch (e: unknown) {
      return {};
    }
  }

  protected _getCapabilityCachePath(): string {
    return path.join(getCacheDir(), CAPABILITY_CACHE_FILE_NAME);
  }

  protected _getCapabilityCacheKey(defaultModelId: string): string {
    if (!this._aiConfig) {
      return `unknown:${defaultModelId}`;
    }

    const providerKey: AiProvider = this._aiConfig.provider;
    if (this._isOpenAiCompatible(providerKey) || this._isLmStudio(providerKey)) {
      const config: IOpenAiCompatibleConfig | ILmStudioConfig = this._getActiveProviderConfig() as IOpenAiCompatibleConfig | ILmStudioConfig;
      const baseUrl: string = normalizeBaseUrl(this._getLocalBaseUrl(config));
      return `${providerKey}:${defaultModelId}:${baseUrl}`;
    }

    return `${providerKey}:${defaultModelId}`;
  }

  protected _resolveBestProbeCandidate(message: { content?: string; reasoning_content?: string } | undefined): string {
    const contentCandidate: string = (message?.content ?? "").trim();
    if (contentCandidate.length > 0) {
      return contentCandidate;
    }

    return (message?.reasoning_content ?? "").trim();
  }

  protected _resolveLlmResponseDiagnosticsEnabled(): boolean {
    try {
      return ConfigService.getInstance().getLoggingConfig().llmResponseDiagnostics === true;
    } catch (e: unknown) {
      return false;
    }
  }

  //#endregion Private methods
}
