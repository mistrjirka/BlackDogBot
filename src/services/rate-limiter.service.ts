import Bottleneck from "bottleneck";

import { IRateLimitConfig } from "../shared/types/index.js";

interface IProviderState {
  limiter: Bottleneck;
  rpmLimit: number;
  tpmLimit: number;
  tokensUsedThisMinute: number;
  requestsUsedThisMinute: number;
  minuteStart: number;
}

export class RateLimiterService {
  //#region Data members

  private static _instance: RateLimiterService | null;
  private _providers: Map<string, IProviderState>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._providers = new Map();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): RateLimiterService {
    if (!RateLimiterService._instance) {
      RateLimiterService._instance = new RateLimiterService();
    }

    return RateLimiterService._instance;
  }

  public createLimiter(
    providerKey: string,
    rateLimits: IRateLimitConfig,
  ): Bottleneck {
    const limiter: Bottleneck = new Bottleneck({
      reservoir: rateLimits.rpm,
      reservoirRefreshAmount: rateLimits.rpm,
      reservoirRefreshInterval: 60000,
      maxConcurrent: Math.min(rateLimits.rpm, 10),
      minTime: Math.ceil(60000 / rateLimits.rpm),
    });

    this._providers.set(providerKey, {
      limiter,
      rpmLimit: rateLimits.rpm,
      tpmLimit: rateLimits.tpm,
      tokensUsedThisMinute: 0,
      requestsUsedThisMinute: 0,
      minuteStart: Date.now(),
    });

    return limiter;
  }

  public getLimiter(providerKey: string): Bottleneck | undefined {
    return this._providers.get(providerKey)?.limiter;
  }

  public getOrCreateLimiter(
    providerKey: string,
    rateLimits: IRateLimitConfig,
  ): Bottleneck {
    const existing: IProviderState | undefined = this._providers.get(providerKey);

    if (existing) {
      return existing.limiter;
    }

    return this.createLimiter(providerKey, rateLimits);
  }

  public async scheduleAsync<T>(
    providerKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const state: IProviderState | undefined = this._providers.get(providerKey);

    if (!state) {
      throw new Error(
        `No rate limiter found for provider "${providerKey}". Call createLimiter() first.`,
      );
    }

    return state.limiter.schedule(fn);
  }

  /**
   * Record token usage and log budget status.
   * Call this after an LLM request completes with the actual tokens used.
   */
  public recordTokenUsage(
    providerKey: string,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const state: IProviderState | undefined = this._providers.get(providerKey);

    if (!state) {
      return;
    }

    const now: number = Date.now();

    // Reset counters if a minute has passed
    if (now - state.minuteStart >= 60000) {
      state.tokensUsedThisMinute = 0;
      state.requestsUsedThisMinute = 0;
      state.minuteStart = now;
    }

    // Add tokens used
    const totalTokens: number = inputTokens + outputTokens;
    state.tokensUsedThisMinute += totalTokens;
    state.requestsUsedThisMinute += 1;

    // Log budget status
    const rpmUsed: number = state.requestsUsedThisMinute;
    const tpmUsed: number = state.tokensUsedThisMinute;

    console.log(
      `📊 Rate Limit Budget: RPM ${rpmUsed}/${state.rpmLimit} (${Math.round((rpmUsed / state.rpmLimit) * 100)}%), ` +
      `TPM ${tpmUsed.toLocaleString()}/${state.tpmLimit.toLocaleString()} (${Math.round((tpmUsed / state.tpmLimit) * 100)}%)`,
    );
  }

  public removeLimiter(providerKey: string): void {
    const state: IProviderState | undefined = this._providers.get(providerKey);

    if (state) {
      state.limiter.disconnect();
      this._providers.delete(providerKey);
    }
  }

  public async destroyAsync(): Promise<void> {
    for (const state of this._providers.values()) {
      state.limiter.disconnect();
    }

    this._providers.clear();
  }

  //#endregion Public methods
}
