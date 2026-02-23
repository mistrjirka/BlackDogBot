import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import type { IAiConfig } from "../../src/shared/types/index.js";
import type { LanguageModel } from "ai";

//#region Helpers

/**
 * Resets AiProviderService and RateLimiterService singletons between tests.
 */
function resetSingletons(): void {
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
}

/** Minimal valid OpenRouter config for testing. */
const openrouterConfig: IAiConfig = {
  provider: "openrouter",
  openrouter: {
    apiKey: "test-key",
    model: "openai/gpt-4o-mini",
    rateLimits: { rpm: 60, tpm: 100000 },
  },
};

/** Minimal valid openai-compatible config for testing. */
const openaiCompatibleConfig: IAiConfig = {
  provider: "openai-compatible",
  openaiCompatible: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "local-key",
    model: "llama3",
    rateLimits: { rpm: 30, tpm: 50000 },
  },
};

//#endregion Helpers

//#region Tests

describe("AiProviderService unit", () => {
  beforeEach(() => {
    resetSingletons();
  });

  afterEach(() => {
    resetSingletons();
  });

  describe("initialize + getDefaultModel (openrouter)", () => {
    it("should initialize with openrouter config and return a valid model", () => {
      // Arrange + Act
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Assert
      const model: LanguageModel = service.getDefaultModel();

      expect(model).toBeDefined();
    });

    it("should report the correct active provider after initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      expect(service.getActiveProvider()).toBe("openrouter");
    });

    it("should return a rate limiter after initialization", () => {
      // Arrange
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Act
      const limiter = service.getRateLimiter();

      // Assert — limiter is a Bottleneck instance (has a `schedule` method)
      expect(limiter).toBeDefined();
      expect(typeof limiter.schedule).toBe("function");
    });

    it("should return a different model instance when getModel is called with an explicit modelId", () => {
      // Arrange
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Act — request a model that is different from the default
      const explicitModel: LanguageModel = service.getModel("anthropic/claude-3-haiku");

      // Assert — returned something (we can't deeply compare provider instances, just ensure defined)
      expect(explicitModel).toBeDefined();
    });

    it("should return the default model when getModel is called without arguments", () => {
      // Arrange
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Act
      const model: LanguageModel = service.getModel();

      expect(model).toBeDefined();
    });
  });

  describe("initialize + getDefaultModel (openai-compatible)", () => {
    it("should initialize with openai-compatible config and return a valid model", () => {
      // Arrange + Act
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openaiCompatibleConfig);

      // Assert
      const model: LanguageModel = service.getDefaultModel();

      expect(model).toBeDefined();
    });

    it("should report openai-compatible as the active provider", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openaiCompatibleConfig);

      expect(service.getActiveProvider()).toBe("openai-compatible");
    });
  });

  describe("error paths", () => {
    it("should throw when getDefaultModel is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getDefaultModel()).toThrow("AiProviderService not initialized");
    });

    it("should throw when getModel is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getModel()).toThrow("AiProviderService not initialized");
    });

    it("should throw when getActiveProvider is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getActiveProvider()).toThrow("AiProviderService not initialized");
    });

    it("should throw when getRateLimiter is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getRateLimiter()).toThrow("AiProviderService not initialized");
    });

    it("should throw when an unsupported provider is set", () => {
      // Arrange — inject an unsupported provider via the private config field.
      // We must pass an explicit modelId so getModel() calls _createModel() directly
      // rather than routing through getDefaultModel() (which additionally gates on _defaultModel).
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "unsupported-provider",
      };

      // Act + Assert
      expect(() => service.getModel("any-model")).toThrow("Unsupported provider");
    });

    it("should throw when openrouter provider has no openrouter config block", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "openrouter",
        // openrouter block intentionally absent
      };

      expect(() => service.getModel("any-model")).toThrow(/No configuration found for provider/);
    });

    it("should throw when openai-compatible provider has no openaiCompatible config block", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "openai-compatible",
        // openaiCompatible block intentionally absent
      };

      expect(() => service.getModel("any-model")).toThrow(/No configuration found for provider/);
    });

    it("should throw when getRateLimiter is called but no limiter was created", () => {
      // Arrange — set config without calling initialize (which creates the limiter)
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "openrouter",
        openrouter: {
          apiKey: "key",
          model: "m",
          rateLimits: { rpm: 60, tpm: 100000 },
        },
      };

      // No createLimiter was called, so getLimiter returns undefined
      expect(() => service.getRateLimiter()).toThrow(/No rate limiter found/);
    });
  });
});

//#endregion Tests
