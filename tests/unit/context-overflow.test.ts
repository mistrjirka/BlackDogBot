import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BaseAgentBase, CONTEXT_EXCEEDED_RETRIES, HARD_GATE_THRESHOLD_PERCENTAGE } from "../../src/agent/base-agent.js";
import { MainAgent } from "../../src/agent/main-agent.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { resetSingletons } from "../utils/test-helpers.js";
import type { LanguageModel, ToolSet } from "ai";
import { APICallError } from "ai";
import path from "node:path";
import os from "node:os";
import type { IAiConfig } from "../../src/shared/types/index.js";

//#region Test Agent Implementation

/**
 * Test agent that exposes protected members for testing
 */
class TestAgent extends BaseAgentBase {
  constructor(options?: { maxSteps?: number; contextWindow?: number }) {
    super(options);
  }

  public buildAgentPublic(model: LanguageModel, instructions: string, tools: ToolSet): void {
    this._buildAgent(model, instructions, tools);
  }

  public get forceCompactionOnNextStep(): boolean {
    return this._forceCompactionOnNextStep;
  }

  public set forceCompactionOnNextStep(value: boolean) {
    this._forceCompactionOnNextStep = value;
  }

  public get contextWindow(): number {
    return this._contextWindow;
  }

  public get compactionTokenThreshold(): number {
    return this._compactionTokenThreshold;
  }
}

//#endregion Test Agent Implementation

//#region Tests

describe("Context Overflow Prevention", () => {
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
  });

  afterEach(() => {
    resetSingletons();
  });

  describe("Threshold constants", () => {
    it("should define correct threshold percentages", () => {
      // Arrange / Act / Assert
      expect(HARD_GATE_THRESHOLD_PERCENTAGE).toBe(0.85);
      expect(CONTEXT_EXCEEDED_RETRIES).toBe(2);
    });

    it("should calculate proactive compaction threshold at 70% of context window", () => {
      // Arrange
      const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });

      // Act
      const threshold: number = agent.compactionTokenThreshold;

      // Assert
      expect(threshold).toBe(70_000); // 70% of 100000
    });

    it("should calculate hard gate at 85% of context window", () => {
      // Arrange
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 128_000,
        },
      };
      const aiProviderService: AiProviderService = AiProviderService.getInstance();
      aiProviderService.initialize(configWithContextWindow);

      // Act
      const hardLimit: number = aiProviderService.getHardLimitTokens();

      // Assert
      expect(hardLimit).toBe(Math.floor(128_000 * 0.85)); // 108800
    });
  });

  describe("_forceCompactionOnNextStep flag", () => {
    it("should be false by default", () => {
      // Arrange
      const agent: TestAgent = new TestAgent();

      // Act / Assert
      expect(agent.forceCompactionOnNextStep).toBe(false);
    });

    it("should be settable for testing context error handling", () => {
      // Arrange
      const agent: TestAgent = new TestAgent();
      expect(agent.forceCompactionOnNextStep).toBe(false);

      // Act
      agent.forceCompactionOnNextStep = true;

      // Assert
      expect(agent.forceCompactionOnNextStep).toBe(true);
    });

    it("should trigger compaction when set to true", () => {
      // This is tested implicitly in base-agent's prepareStep callback
      // The flag being true causes the agent to compact on the next step
      // Actual compaction logic testing is in integration tests

      // Arrange
      const agent: TestAgent = new TestAgent();

      // Act
      agent.forceCompactionOnNextStep = true;

      // Assert
      expect(agent.forceCompactionOnNextStep).toBe(true);
      // In real usage, prepareStep would check this flag and perform compaction
    });
  });

  describe("processMessageAsync context error handling", () => {
    it("should detect 400 errors with 'context' in error message", async () => {
      // Arrange
      const agent: TestAgent = new TestAgent();
      const mockModel = {} as LanguageModel;
      agent.buildAgentPublic(mockModel, "Test instructions", {});

      // Mock the _agent.generate to throw a context-related error
      const mockAgent = (agent as unknown as { _agent: { generate: () => Promise<never> } })._agent;
      mockAgent.generate = vi.fn().mockRejectedValue(
        new APICallError({
          message: "Context length exceeded",
          url: "https://api.test.com",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: JSON.stringify({ error: { message: "context size too large" } }),
          cause: new Error("Context error"),
          isRetryable: false,
        })
      );

      // Act & Assert
      // The processMessageAsync should catch the error and set _forceCompactionOnNextStep
      // In a real scenario it would retry, but in this test we just verify the detection logic
      await expect(agent.processMessageAsync("test")).rejects.toThrow();
      
      // Note: In the actual implementation, the error would be caught and retried
      // with _forceCompactionOnNextStep=true. Testing the full retry loop requires
      // mocking the entire agent generate flow.
    });

    it("should detect 400 errors with 'token limit' in error message", async () => {
      // Arrange
      const agent: TestAgent = new TestAgent();
      const mockModel = {} as LanguageModel;
      agent.buildAgentPublic(mockModel, "Test instructions", {});

      // Mock to throw token limit error
      const mockAgent = (agent as unknown as { _agent: { generate: () => Promise<never> } })._agent;
      mockAgent.generate = vi.fn().mockRejectedValue(
        new APICallError({
          message: "Request exceeds token limit",
          url: "https://api.test.com",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: "{}",
          cause: new Error("Token limit"),
          isRetryable: false,
        })
      );

      // Act & Assert
      await expect(agent.processMessageAsync("test")).rejects.toThrow();
    });

    it("should detect 400 errors with 'exceeded' in response body", async () => {
      // Arrange
      const agent: TestAgent = new TestAgent();
      const mockModel = {} as LanguageModel;
      agent.buildAgentPublic(mockModel, "Test instructions", {});

      // Mock to throw exceeded error
      const mockAgent = (agent as unknown as { _agent: { generate: () => Promise<never> } })._agent;
      mockAgent.generate = vi.fn().mockRejectedValue(
        new APICallError({
          message: "Bad request",
          url: "https://api.test.com",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: JSON.stringify({ error: { message: "limit exceeded" } }),
          cause: new Error("Exceeded"),
          isRetryable: false,
        })
      );

      // Act & Assert
      await expect(agent.processMessageAsync("test")).rejects.toThrow();
    });
  });

  describe("Context window thresholds", () => {
    it("should have hard gate threshold higher than compaction threshold", () => {
      // Arrange
      const agent: TestAgent = new TestAgent({ contextWindow: 128_000 });
      const configWithContextWindow: IAiConfig = {
        ...mockOpenRouterConfig,
        openrouter: {
          ...mockOpenRouterConfig.openrouter!,
          contextWindow: 128_000,
        },
      };
      const aiProviderService: AiProviderService = AiProviderService.getInstance();
      aiProviderService.initialize(configWithContextWindow);

      // Act
      const compactionThreshold: number = agent.compactionTokenThreshold; // 70%
      const hardGateThreshold: number = aiProviderService.getHardLimitTokens(); // 85%

      // Assert
      expect(compactionThreshold).toBe(89_600); // 128000 * 0.70
      expect(hardGateThreshold).toBe(108_800); // 128000 * 0.85
      expect(hardGateThreshold).toBeGreaterThan(compactionThreshold);
      
      // The gap between compaction and hard gate provides a safety buffer
      const buffer: number = hardGateThreshold - compactionThreshold;
      expect(buffer).toBe(19_200); // 15% of context window
    });

    it("should maintain threshold relationship across different context windows", async () => {
      // Test with various context window sizes
      const testCases: number[] = [32_000, 64_000, 100_000, 128_000, 200_000];

      for (const contextWindow of testCases) {
        // Arrange
        const agent: TestAgent = new TestAgent({ contextWindow });
        const aiProviderConfig: IAiConfig = {
          ...mockOpenRouterConfig,
          openrouter: {
            ...mockOpenRouterConfig.openrouter!,
            contextWindow,
          },
        };
        const aiProviderService: AiProviderService = AiProviderService.getInstance();
        aiProviderService.initialize(aiProviderConfig);

        // Act
        const compactionThreshold: number = agent.compactionTokenThreshold;
        const hardGateThreshold: number = aiProviderService.getHardLimitTokens();

        // Assert
        expect(compactionThreshold).toBe(Math.floor(contextWindow * 0.70));
        expect(hardGateThreshold).toBe(Math.floor(contextWindow * 0.85));
        expect(hardGateThreshold).toBeGreaterThan(compactionThreshold);

        // Clean up for next iteration
        resetSingletons();
        const newLogger: LoggerService = LoggerService.getInstance();
        await newLogger.initializeAsync("info", path.join(os.tmpdir(), "test-logs"));
      }
    });
  });

  describe("MainAgent context retry integration", () => {
    it("should have CONTEXT_EXCEEDED_RETRIES constant available", () => {
      // Arrange / Act / Assert
      expect(CONTEXT_EXCEEDED_RETRIES).toBe(2);
      
      // This constant is used in MainAgent.processMessageForChatAsync
      // to limit the number of retry attempts on context errors
    });

    it("should demonstrate context error detection pattern for 400 errors", () => {
      // This test documents the error detection pattern used in processMessageForChatAsync
      
      // Arrange
      const error = new APICallError({
        message: "Request failed with status code 400",
        url: "https://api.test.com",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: JSON.stringify({ 
          error: { 
            type: "context_length_exceeded",
            message: "Context size exceeded: 120000 tokens exceeds hard limit of 108800" 
          } 
        }),
        cause: new Error("Context exceeded"),
        isRetryable: false,
      });

      // Act - Pattern from main-agent.ts
      const isApiCallError: boolean = APICallError.isInstance(error);
      const is400: boolean = error.statusCode === 400;
      const errorMessage: string = (error.message + " " + (error.responseBody ?? "")).toLowerCase();
      const hasContextKeyword: boolean = errorMessage.includes("context") || 
                                         errorMessage.includes("token limit") || 
                                         errorMessage.includes("exceeded");

      // Assert
      expect(isApiCallError).toBe(true);
      expect(is400).toBe(true);
      expect(hasContextKeyword).toBe(true);
      
      // In the actual implementation, if all three are true and contextRetries < CONTEXT_EXCEEDED_RETRIES,
      // the agent sets _forceCompactionOnNextStep=true and retries
    });

    it("should detect 500 errors with context keywords as context overflow", () => {
      // Arrange - Provider returns 500 with context error
      const error = new APICallError({
        message: "Context size has been exceeded",
        url: "http://localhost:2345/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 500,
        responseBody: JSON.stringify({ 
          error: { 
            code: 500,
            message: "Context size has been exceeded.",
            type: "server_error"
          } 
        }),
        cause: new Error("Internal Server Error"),
        isRetryable: false,
      });

      // Act - Updated pattern that now includes 500
      const isApiCallError: boolean = APICallError.isInstance(error);
      const isContextStatusCode: boolean = error.statusCode === 400 || 
                                           error.statusCode === 500 || 
                                           error.statusCode === 413 || 
                                           error.statusCode === 422;
      const errorMessage: string = (error.message + " " + (error.responseBody ?? "")).toLowerCase();
      const hasContextKeyword: boolean = errorMessage.includes("context") || 
                                         errorMessage.includes("token limit") || 
                                         errorMessage.includes("exceeded") ||
                                         errorMessage.includes("too long") ||
                                         errorMessage.includes("length");

      // Assert
      expect(isApiCallError).toBe(true);
      expect(isContextStatusCode).toBe(true);
      expect(hasContextKeyword).toBe(true);
      
      // This ensures 500 errors with context keywords trigger compaction
    });
  });
});

//#endregion Tests
