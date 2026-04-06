import { describe, it, expect, vi, afterEach } from "vitest";
import { probeParallelToolCallSupportAsync } from "../../../src/services/parallel-tool-call-probe.service.js";

describe("probeParallelToolCallSupportAsync", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when server responds 200 OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 5000,
    });

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:2345/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("returns false when server responds 400", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "unknown parameter" } }),
    });

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 5000,
    });

    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 5000,
    });

    expect(result).toBe(false);
  });

  it("returns false on timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10000)),
    );

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 100,
    });

    expect(result).toBe(false);
  });
});
