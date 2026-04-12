import { describe, it, expect, vi, beforeEach } from "vitest";
import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";
import { APICallError } from "ai";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";

vi.mock("../../../src/utils/llm-retry.js", () => ({
  generateObjectWithRetryAsync: vi.fn(),
}));

describe("CronMessageHistoryService - Fallback Behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    
    const mockModel = {
      completion: vi.fn(),
    };
    const mockAiProviderService = {
      getModel: vi.fn().mockReturnValue(mockModel),
    };
    vi.spyOn(AiProviderService, "getInstance").mockReturnValue(mockAiProviderService as any);
  });

  describe("checkMessageNoveltyAsync error fallback", () => {
    it("returns isNewInformation true when similarity search throws", async () => {
      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service, "getSimilarMessagesAsync").mockRejectedValueOnce(new Error("Vector store unavailable"));

      const result = await service.checkMessageNoveltyAsync(
        "task-123",
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.isNewInformation).toBe(true);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Vector store unavailable");
    });

    it("returns isNewInformation true when LLM call throws", async () => {
      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service, "getSimilarMessagesAsync").mockResolvedValue([
        { content: "similar", sentAt: "2026-01-01", score: 0.9, taskId: "task-123" },
      ]);

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(new Error("LLM unavailable"));

      const result = await service.checkMessageNoveltyAsync(
        "task-123",
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.isNewInformation).toBe(true);
      expect(result.error).toBeDefined();
    });

    it("logs warning when novelty check fails", async () => {
      const { LoggerService } = await import("../../../src/services/logger.service.js");
      const loggerSpy = vi.spyOn(LoggerService.getInstance(), "warn");

      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service, "getSimilarMessagesAsync").mockRejectedValueOnce(new Error("Search failed"));

      await service.checkMessageNoveltyAsync("task-123", "Test message");

      expect(loggerSpy).toHaveBeenCalledWith(
        "Cron message novelty check failed",
        expect.objectContaining({
          taskId: "task-123",
          error: expect.stringContaining("Search failed"),
        }),
      );
    });
  });

  describe("checkMessageDispatchPolicyAsync error classification", () => {
    it("returns shouldDispatch true for transient/retriable errors", async () => {
      const transientError = new APICallError({
        message: "Connection reset",
        url: "https://api.example.com",
        requestBodyValues: { model: "test" },
        responseBody: "connection reset",
        statusCode: null,
        isRetryable: true,
      });

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(transientError);

      const service = CronMessageHistoryService.getInstance();
      const result = await service.checkMessageDispatchPolicyAsync(
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.shouldDispatch).toBe(true);
      expect(result.error).toBeDefined();
    });

    it("returns shouldDispatch true for network/connection errors", async () => {
      const networkError = new Error("fetch failed: connection refused");

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(networkError);

      const service = CronMessageHistoryService.getInstance();
      const result = await service.checkMessageDispatchPolicyAsync(
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.shouldDispatch).toBe(true);
      expect(result.error).toBeDefined();
    });

    it("returns shouldDispatch false for authentication errors (401)", async () => {
      const authError = new APICallError({
        message: "Invalid API key",
        url: "https://api.example.com",
        requestBodyValues: { model: "test" },
        responseBody: "Unauthorized",
        statusCode: 401,
        isRetryable: false,
      });

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(authError);

      const service = CronMessageHistoryService.getInstance();
      const result = await service.checkMessageDispatchPolicyAsync(
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.shouldDispatch).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns shouldDispatch false for authorization errors (403)", async () => {
      const authError = new APICallError({
        message: "Access forbidden",
        url: "https://api.example.com",
        requestBodyValues: { model: "test" },
        responseBody: "Forbidden",
        statusCode: 403,
        isRetryable: false,
      });

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(authError);

      const service = CronMessageHistoryService.getInstance();
      const result = await service.checkMessageDispatchPolicyAsync(
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.shouldDispatch).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns shouldDispatch false for schema/validation errors", async () => {
      const schemaError = new APICallError({
        message: "Invalid request parameters",
        url: "https://api.example.com",
        requestBodyValues: { model: "test" },
        responseBody: "Validation error",
        statusCode: 422,
        isRetryable: false,
      });

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(schemaError);

      const service = CronMessageHistoryService.getInstance();
      const result = await service.checkMessageDispatchPolicyAsync(
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.shouldDispatch).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns shouldDispatch false for context length exceeded errors", async () => {
      const contextError = new APICallError({
        message: "Context length exceeded",
        url: "https://api.example.com",
        requestBodyValues: { model: "test" },
        responseBody: "context_length_exceeded",
        statusCode: 400,
        isRetryable: false,
      });

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(contextError);

      const service = CronMessageHistoryService.getInstance();
      const result = await service.checkMessageDispatchPolicyAsync(
        "Test message",
        "instructions",
        "taskName",
        "description",
      );

      expect(result.shouldDispatch).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("preserves error string in return object for all error types", async () => {
      const errorMessage = "Rate limit exceeded";
      const rateLimitError = new APICallError({
        message: errorMessage,
        url: "https://api.example.com",
        requestBodyValues: { model: "test" },
        responseBody: "rate_limit_exceeded",
        statusCode: 429,
        isRetryable: true,
      });

      const { generateObjectWithRetryAsync } = await import("../../../src/utils/llm-retry.js");
      vi.mocked(generateObjectWithRetryAsync).mockRejectedValueOnce(rateLimitError);

      const service = CronMessageHistoryService.getInstance();
      const result = await service.checkMessageDispatchPolicyAsync("Test message", "instructions");

      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    });
  });
});
