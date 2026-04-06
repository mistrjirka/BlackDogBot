/**
 * Minimal capability detection service for LangChain-based agents.
 * Reads configuration directly from ConfigService - no API probing.
 * 
 * For vision support, set `supportsVision: true` in your provider config:
 * - openrouter.supportsVision
 * - openaiCompatible.supportsVision
 * - lmStudio.supportsVision
 */

import { ConfigService } from "./config.service.js";
import type { IAiConfig, IOpenRouterConfig, IOpenAiCompatibleConfig, ILmStudioConfig, AiProvider } from "../shared/types/config.types.js";

//#region Types

export interface IAiCapabilityInfo {
  supportsVision: boolean;
  contextWindow: number;
  activeModelId: string;
  activeProvider: AiProvider;
}

//#endregion Types

//#region AiCapabilityService

export class AiCapabilityService {
  private static _instance: AiCapabilityService | null = null;
  private _config: IAiConfig | null = null;
  private _supportsParallelToolCalls: boolean = false;

  public static getInstance(): AiCapabilityService {
    if (!AiCapabilityService._instance) {
      AiCapabilityService._instance = new AiCapabilityService();
    }
    return AiCapabilityService._instance;
  }

  private constructor() {}

  /**
   * Initialize with current AI config.
   * Called once at startup.
   */
  public initialize(config: IAiConfig): void {
    this._config = config;
  }

  /**
   * Get the active provider name.
   */
  public getActiveProvider(): AiProvider {
    return this._config?.provider ?? "openrouter";
  }

  /**
   * Get the active model ID.
   */
  public getActiveModelId(): string {
    const providerConfig = this._getProviderConfig();
    if (!providerConfig) {
      return "unknown";
    }
    return providerConfig.model;
  }

  /**
   * Get the context window size for the current model.
   * Returns safe defaults if not configured.
   */
  public getContextWindow(): number {
    const providerConfig = this._getProviderConfig();
    if (providerConfig?.contextWindow) {
      return providerConfig.contextWindow;
    }
    // Safe defaults based on provider
    const provider = this.getActiveProvider();
    return provider === "openrouter" ? 128000 : 32768;
  }

  /**
   * Check if the current model supports vision/image inputs.
   * Returns true only if explicitly configured.
   */
  public getSupportsVision(): boolean {
    const providerConfig = this._getProviderConfig();
    if (!providerConfig) {
      return false;
    }
    // Check for supportsVision property on any provider config
    if ("supportsVision" in providerConfig && typeof providerConfig.supportsVision === "boolean") {
      return providerConfig.supportsVision;
    }
    return false;
  }

  /**
   * Check if the current model/server supports parallel tool calls.
   * Returns false until explicitly set via probe or config override.
   */
  public getSupportsParallelToolCalls(): boolean {
    return this._supportsParallelToolCalls;
  }

  /**
   * Set the parallel tool calls support flag.
   * Called by the startup probe or config override.
   */
  public setSupportsParallelToolCalls(supported: boolean): void {
    this._supportsParallelToolCalls = supported;
  }

  /**
   * Get all capability info in a single call.
   */
  public getCapabilityInfo(): IAiCapabilityInfo {
    return {
      supportsVision: this.getSupportsVision(),
      contextWindow: this.getContextWindow(),
      activeModelId: this.getActiveModelId(),
      activeProvider: this.getActiveProvider(),
    };
  }

  /**
   * Get provider-specific configuration.
   */
  private _getProviderConfig(): IOpenRouterConfig | IOpenAiCompatibleConfig | ILmStudioConfig | null {
    if (!this._config) {
      // Try to get config from ConfigService if not initialized
      this._config = ConfigService.getInstance().getConfig().ai;
    }
    
    if (!this._config) {
      return null;
    }

    const provider = this._config.provider;
    
    if (provider === "openrouter") {
      return this._config.openrouter ?? null;
    }
    
    if (provider === "openai-compatible") {
      return this._config.openaiCompatible ?? null;
    }
    
    return this._config.lmStudio ?? null;
  }
}

//#endregion AiCapabilityService