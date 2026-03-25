/**
 * Minimal capability detection service for LangChain-based agents.
 * Provides vision support, context window, and model ID info without
 * depending on Vercel AI SDK directly.
 * 
 * This is a facade over AiProviderService for the new LangChain architecture.
 */

import { AiProviderService } from "./ai-provider.service.js";

//#region Types

export interface IAiCapabilityInfo {
  supportsVision: boolean;
  contextWindow: number;
  activeModelId: string;
  activeProvider: string;
}

//#endregion Types

//#region AiCapabilityService

export class AiCapabilityService {
  private static _instance: AiCapabilityService | null = null;
  private _aiProvider: AiProviderService;

  public static getInstance(): AiCapabilityService {
    if (!AiCapabilityService._instance) {
      AiCapabilityService._instance = new AiCapabilityService();
    }
    return AiCapabilityService._instance;
  }

  private constructor() {
    this._aiProvider = AiProviderService.getInstance();
  }

  /**
   * Returns true if the current model supports vision/image inputs.
   */
  public getSupportsVision(): boolean {
    return this._aiProvider.getSupportsVision();
  }

  /**
   * Returns the context window size for the current model.
   */
  public getContextWindow(): number {
    return this._aiProvider.getContextWindow();
  }

  /**
   * Returns the active model ID.
   */
  public getActiveModelId(): string {
    return this._aiProvider.getActiveModelId();
  }

  /**
   * Returns the active provider name.
   */
  public getActiveProvider(): string {
    return this._aiProvider.getActiveProvider();
  }

  /**
   * Returns all capability info in a single call.
   */
  public getCapabilityInfo(): IAiCapabilityInfo {
    return {
      supportsVision: this.getSupportsVision(),
      contextWindow: this.getContextWindow(),
      activeModelId: this.getActiveModelId(),
      activeProvider: this.getActiveProvider(),
    };
  }
}

//#endregion AiCapabilityService