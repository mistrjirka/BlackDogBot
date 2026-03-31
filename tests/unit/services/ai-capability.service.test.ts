import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { createTestEnvironment, resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";

const env = createTestEnvironment("ai-capability-unit");

describe("AiCapabilityService", () => {
  let service: AiCapabilityService;

  beforeEach(async () => {
    await env.setupAsync({ logLevel: "error" });
    resetSingletons();
    const logger = LoggerService.getInstance();
    silenceLogger(logger);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();
    await env.teardownAsync();
  });

  describe("getSupportsParallelToolCalls", () => {
    beforeEach(() => {
      service = AiCapabilityService.getInstance();
    });

    it("returns false by default (before probe)", () => {
      service.initialize({
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "http://localhost:2345/v1",
          apiKey: "test-key",
          model: "qwen3.5:latest",
        },
      });
      expect(service.getSupportsParallelToolCalls()).toBe(false);
    });

    it("returns true after setSupportsParallelToolCalls(true)", () => {
      service.initialize({
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "http://localhost:2345/v1",
          apiKey: "test-key",
          model: "qwen3.5:latest",
        },
      });
      service.setSupportsParallelToolCalls(true);
      expect(service.getSupportsParallelToolCalls()).toBe(true);
    });

    it("returns false after setSupportsParallelToolCalls(false)", () => {
      service.initialize({
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "http://localhost:2345/v1",
          apiKey: "test-key",
          model: "qwen3.5:latest",
        },
      });
      service.setSupportsParallelToolCalls(false);
      expect(service.getSupportsParallelToolCalls()).toBe(false);
    });
  });
});
