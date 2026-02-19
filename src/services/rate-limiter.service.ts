import Bottleneck from "bottleneck";

import { IRateLimitConfig } from "../shared/types/index.js";

export class RateLimiterService {
  //#region Data members

  private static _instance: RateLimiterService | null;
  private _limiters: Map<string, Bottleneck>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._limiters = new Map();
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

    this._limiters.set(providerKey, limiter);

    return limiter;
  }

  public getLimiter(providerKey: string): Bottleneck | undefined {
    return this._limiters.get(providerKey);
  }

  public getOrCreateLimiter(
    providerKey: string,
    rateLimits: IRateLimitConfig,
  ): Bottleneck {
    const existing: Bottleneck | undefined = this._limiters.get(providerKey);

    if (existing) {
      return existing;
    }

    return this.createLimiter(providerKey, rateLimits);
  }

  public async scheduleAsync<T>(
    providerKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const limiter: Bottleneck | undefined = this._limiters.get(providerKey);

    if (!limiter) {
      throw new Error(
        `No rate limiter found for provider "${providerKey}". Call createLimiter() first.`,
      );
    }

    return limiter.schedule(fn);
  }

  public removeLimiter(providerKey: string): void {
    const limiter: Bottleneck | undefined = this._limiters.get(providerKey);

    if (limiter) {
      limiter.disconnect();
      this._limiters.delete(providerKey);
    }
  }

  public async destroyAsync(): Promise<void> {
    for (const limiter of this._limiters.values()) {
      limiter.disconnect();
    }

    this._limiters.clear();
  }

  //#endregion Public methods
}
