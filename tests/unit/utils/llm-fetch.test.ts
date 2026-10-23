import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { Agent } from "undici";
import { fetchLlmAsync } from "../../../src/utils/llm-fetch.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("model-only HTTP transport", () => {
  it("overrides fetch parser deadlines without changing ordinary requests", async () => {
    const dispatch = vi.spyOn(Agent.prototype, "dispatch");
    const server = http.createServer((_req, res) => { setTimeout(() => res.end("ok"), 50); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    try {
      expect(await (await fetchLlmAsync(url)).text()).toBe("ok");
      expect(dispatch.mock.calls.some(([options]) => options.headersTimeout === 0 && options.bodyTimeout === 0)).toBe(true);
      const ordinaryFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ordinary"));
      await fetch("http://example.test");
      expect(ordinaryFetch.mock.calls.at(-1)?.[1]).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("honors caller cancellation while waiting for headers", async () => {
    const server = http.createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const controller = new AbortController();
      const pending = fetchLlmAsync(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, { signal: controller.signal });
      controller.abort(new DOMException("stopped", "AbortError"));
      await expect(pending).rejects.toThrow("stopped");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
