import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { RetryOrchestrator, type IRetryOrchestratorConfig } from "../../src/agent/retry-orchestrator.js";
import { LlmRequestTimeoutError, LlmIncompleteResponseError } from "../../src/utils/llm-fetch.js";

function config(generateFn: IRetryOrchestratorConfig["generateFn"]): IRetryOrchestratorConfig {
  return {
    chatId: "test", logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), logStructured: vi.fn() } as any,
    model: {} as any, maxSteps: 100, compactionThreshold: 1000, contextWindow: 2000,
    generateFn, buildMessagesForCall: () => [], abortSignal: new AbortController().signal,
    resetTokenCounters: vi.fn(), totalInputTokensSink: vi.fn(), emitModelOutputAsync: vi.fn(),
  };
}

describe("consecutive generation retries", () => {
  it("resets retries after completed steps, retaining work for the next request", async () => {
    let progress = 0;
    const generate = vi.fn(async () => {
      if (generate.mock.calls.length <= 6) {
        progress++;
        throw new Error("invalid json response");
      }
      return { text: "done" };
    });
    const options = config(generate);
    options.getProgressVersion = () => progress;
    const result = await RetryOrchestrator.runCycle(options);
    expect(result.result.text).toBe("done");
    expect(generate).toHaveBeenCalledTimes(7);
  });

  it("still stops after consecutive failures without progress", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("invalid json response"));
    const options = config(generate);
    options.getProgressVersion = () => 0;
    expect((await RetryOrchestrator.runCycle(options)).shouldFallback).toBe(true);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("does not multiply an exhausted transport timeout with agent retries", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("wrapped", {
      cause: new LlmRequestTimeoutError(1200000, 2, 2, new Error("aborted")),
    }));
    const result = await RetryOrchestrator.runCycle(config(generate));
    expect(result.result.text).toContain("Completed tool work is preserved");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not publish or retry a length-truncated final answer", async () => {
    const generate = vi.fn().mockResolvedValue({ text: "unfinished", steps: [{ finishReason: "length" }] });
    const result = await RetryOrchestrator.runCycle(config(generate));
    expect(result.shouldFallback).toBe(true);
    expect(result.result.text).not.toContain("unfinished");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("handles incomplete provider responses without repeated generation", async () => {
    const generate = vi.fn().mockRejectedValue(new LlmIncompleteResponseError("truncated"));
    const result = await RetryOrchestrator.runCycle(config(generate));
    expect(result.shouldFallback).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("stops without resending when context compaction made no progress", async () => {
    const contextError = new APICallError({
      message: "Context size exceeded", url: "http://localhost",
      requestBodyValues: {}, statusCode: 400,
      responseBody: "context_length_exceeded",
    });
    const generate = vi.fn().mockRejectedValue(contextError);
    const options = config(generate);
    options.onContextExceededCompaction = vi.fn().mockResolvedValue(null);
    const result = await RetryOrchestrator.runCycle(options);
    expect(result.shouldFallback).toBe(true);
    expect(result.result.text).toContain("compaction could not reduce");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(options.onContextExceededCompaction).toHaveBeenCalledTimes(1);
  });

  it("does not retry cancellation with an arbitrary reason", async () => {
    const controller = new AbortController();
    const generate = vi.fn(async () => { controller.abort(); throw new Error("custom cancellation"); });
    const options = config(generate);
    options.abortSignal = controller.signal;
    await expect(RetryOrchestrator.runCycle(options)).rejects.toThrow("custom cancellation");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
