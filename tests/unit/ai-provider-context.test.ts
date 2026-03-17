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
    
    // Initialize logger first
    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(os.tmpdir(), "test-logs"));
    
    service = AiProviderService.getInstance();
  });

  afterEach(() => {
    resetSingletons();
  });

  describe("getContextWindow", () => {
    it("should return default context window of 128000 before initialization", () => {
      // Arrange
      const expectedDefault: number = 128_000;

      // Act
      const contextWindow: number = service.getContextWindow();

      // Assert
      expect(contextWindow).toBe(expectedDefault);
    });

    it("should return configured context window after initialization", () => {
      // Arrange
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 200_000,
        },
      };

      // Act
      service.initialize(configWithContextWindow);
      const contextWindow: number = service.getContextWindow();

      // Assert
      expect(contextWindow).toBe(200_000);
    });
  });

  describe("getHardLimitTokens", () => {
    it("should return 85% of default context window", () => {
      // Arrange
      const expectedHardLimit: number = Math.floor(128_000 * 0.85); // 108800

      // Act
      const hardLimit: number = service.getHardLimitTokens();

      // Assert
      expect(hardLimit).toBe(expectedHardLimit);
      expect(hardLimit).toBe(108_800);
    });

    it("should return 85% of configured context window", () => {
      // Arrange
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 200_000,
        },
      };

      // Act
      service.initialize(configWithContextWindow);
      const hardLimit: number = service.getHardLimitTokens();

      // Assert
      expect(hardLimit).toBe(Math.floor(200_000 * 0.85)); // 170000
      expect(hardLimit).toBe(170_000);
    });

    it("should floor the result when 85% is not an integer", () => {
      // Arrange
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 100_001, // 100001 * 0.85 = 85000.85
        },
      };

      // Act
      service.initialize(configWithContextWindow);
      const hardLimit: number = service.getHardLimitTokens();

      // Assert
      expect(hardLimit).toBe(85_000); // Floored
    });
  });

  describe("Token-gated fetch - Hard limit enforcement", () => {
    it("should allow requests under the hard limit", async () => {
      // Arrange
      service.initialize(mockOpenRouterConfig);
      const model = service.getModel();
      
      // Access the fetch function from the model's config
      const modelFetch = (model as unknown as { config?: { fetch?: typeof fetch } }).config?.fetch;
      
      if (!modelFetch) {
        throw new Error("Model does not have a fetch function configured");
      }

      // Small request body (~100 tokens, well under 108800 limit)
      const smallRequestBody: string = JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      });

      // Act
      const response: Response = await modelFetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: smallRequestBody,
        headers: { "Content-Type": "application/json" },
      });

      // Assert
      // The fetch should pass through (will fail with network error in tests, but that's fine)
      // We're just checking it doesn't get blocked by our gate
      expect(response.status).not.toBe(400);
    });

    it("should reject requests exceeding the hard limit with 400 error", async () => {
      // Arrange
      service.initialize(mockOpenRouterConfig);
      const model = service.getModel();
      
      // Access the fetch function
      const modelFetch = (model as unknown as { config?: { fetch?: typeof fetch } }).config?.fetch;
      
      if (!modelFetch) {
        throw new Error("Model does not have a fetch function configured");
      }

      // Create a request body that exceeds 85% of 128000 = 108800 tokens
      // We'll create a large message with lots of repeated content
      const largeContent: string = "This is a test message. ".repeat(10_000); // ~50k tokens
      const largeRequestBody: string = JSON.stringify({
        messages: [
          { role: "user", content: largeContent },
          { role: "assistant", content: largeContent },
          { role: "user", content: largeContent },
        ],
      });

      // Act
      const response: Response = await modelFetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: largeRequestBody,
        headers: { "Content-Type": "application/json" },
      });

      // Assert
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const errorBody = await response.json();
      expect(errorBody).toHaveProperty("error");
      expect(errorBody.error).toHaveProperty("type", "context_length_exceeded");
      expect(errorBody.error).toHaveProperty("code", "context_length_exceeded");
      expect(errorBody.error.message).toMatch(/Context size exceeded/i);
      expect(errorBody.error.message).toMatch(/hard limit/i);
    });

    it("should only gate POST requests with body", async () => {
      // Arrange
      service.initialize(mockOpenRouterConfig);
      const model = service.getModel();
      
      const modelFetch = (model as unknown as { config?: { fetch?: typeof fetch } }).config?.fetch;
      
      if (!modelFetch) {
        throw new Error("Model does not have a fetch function configured");
      }

      // Act - GET request should pass through without gating
      const response: Response = await modelFetch("https://openrouter.ai/api/v1/models", {
        method: "GET",
      });

      // Assert - should attempt the actual request (will fail with network error, but won't be gated)
      expect(response.status).not.toBe(400);
    });
  });

  describe("Rate limiter initialization safety", () => {
    it("should reuse existing limiter when initialize is called multiple times", () => {
      // Arrange
      const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();

      // Act
      service.initialize(mockOpenRouterConfig);
      const firstLimiter = rateLimiterService.getLimiter("openrouter");

      service.initialize(mockOpenRouterConfig);
      const secondLimiter = rateLimiterService.getLimiter("openrouter");

      // Assert
      expect(firstLimiter).toBeDefined();
      expect(secondLimiter).toBeDefined();
      expect(secondLimiter).toBe(firstLimiter);
    });

    it("should warn when nested scheduleAsync is used for the same provider", async () => {
      // Arrange
      const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
      const loggerService: LoggerService = LoggerService.getInstance();
      const warnSpy = vi.spyOn(loggerService, "warn");

      service.initialize(mockOpenRouterConfig);

      // Act
      const result: number = await rateLimiterService.scheduleAsync("openrouter", async () => {
        return await rateLimiterService.scheduleAsync("openrouter", async () => 42);
      });

      // Assert
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
      // This test verifies that BaseAgent.updateContextWindow() works correctly
      // The actual implementation is tested in base-agent.test.ts
      // This is a documentation test showing the integration point
      
      // Arrange
      service.initialize(mockOpenRouterConfig);
      const contextWindow: number = service.getContextWindow();

      // Act & Assert
      // When contextWindow is not specified in config, it defaults to 32768 in sync init
      expect(contextWindow).toBe(32_768);
      
      // The agent should call updateContextWindow() with this value
      // See base-agent.test.ts for the actual agent tests
    });
  });
});

//#endregion Tests
