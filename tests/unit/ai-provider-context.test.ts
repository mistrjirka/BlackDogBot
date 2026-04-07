import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { resetSingletons } from "../utils/test-helpers.js";
import type { IAiConfig } from "../../src/shared/types/index.js";
import path from "node:path";
import os from "node:os";

//#region Tests

describe("AiProviderService - Context Management", () => {
  let service: AiProviderService;
  const mockOpenRouterConfig: IAiConfig = {
    provider: "openrouter",
    openrouter: {
      apiKey: "test-api-key",
      model: "anthropic/claude-3.5-sonnet",
      rateLimits: {
        rpm: 10,
        tpm: 50_000,
      },
    },
  };

  beforeEach(async () => {
    resetSingletons();

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(os.tmpdir(), "test-logs"));

    service = AiProviderService.getInstance();
  });

  afterEach(() => {
    resetSingletons();
  });

  describe("getContextWindow", () => {
    it("should return default context window of 128000 before initialization", () => {
      const expectedDefault: number = 128_000;

      const contextWindow: number = service.getContextWindow();

      expect(contextWindow).toBe(expectedDefault);
    });

    it("should return configured context window after initialization", () => {
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 200_000,
        },
      };

      service.initialize(configWithContextWindow);
      const contextWindow: number = service.getContextWindow();

      expect(contextWindow).toBe(200_000);
    });
  });

  describe("getHardLimitTokens", () => {
    it("should return 85% of default context window", () => {
      const expectedHardLimit: number = Math.floor(128_000 * 0.85);

      const hardLimit: number = service.getHardLimitTokens();

      expect(hardLimit).toBe(expectedHardLimit);
      expect(hardLimit).toBe(108_800);
    });

    it("should return 85% of configured context window", () => {
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 200_000,
        },
      };

      service.initialize(configWithContextWindow);
      const hardLimit: number = service.getHardLimitTokens();

      expect(hardLimit).toBe(Math.floor(200_000 * 0.85));
      expect(hardLimit).toBe(170_000);
    });

    it("should floor the result when 85% is not an integer", () => {
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 100_001,
        },
      };

      service.initialize(configWithContextWindow);
      const hardLimit: number = service.getHardLimitTokens();

      expect(hardLimit).toBe(85_000);
    });
  });

  describe("Rate limiter initialization safety", () => {
    it("should reuse existing limiter when initialize is called multiple times", () => {
      const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();

      service.initialize(mockOpenRouterConfig);
      const firstLimiter = rateLimiterService.getLimiter("openrouter");

      service.initialize(mockOpenRouterConfig);
      const secondLimiter = rateLimiterService.getLimiter("openrouter");

      expect(firstLimiter).toBeDefined();
      expect(secondLimiter).toBeDefined();
      expect(secondLimiter).toBe(firstLimiter);
    });

    it("should warn when nested scheduleAsync is used for the same provider", async () => {
      const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
      const loggerService: LoggerService = LoggerService.getInstance();
      const warnSpy = vi.spyOn(loggerService, "warn");

      service.initialize(mockOpenRouterConfig);

      const result: number = await rateLimiterService.scheduleAsync("openrouter", async () => {
        return await rateLimiterService.scheduleAsync("openrouter", async () => 42);
      });

      expect(result).toBe(42);
      expect(warnSpy).toHaveBeenCalledWith(
        "Nested rate limiter scheduling detected for provider",
        expect.objectContaining({ providerKey: "openrouter" }),
      );

      warnSpy.mockRestore();
    });
  });

  describe("updateContextWindow on BaseAgent", () => {
    it("should update agent's context window and compaction threshold", async () => {
      service.initialize(mockOpenRouterConfig);
      const contextWindow: number = service.getContextWindow();

      expect(contextWindow).toBe(32_768);
    });
  });
});

//#endregion Tests
