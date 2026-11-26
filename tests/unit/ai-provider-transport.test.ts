import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AiProviderCore } from "../../src/services/ai-provider/ai-provider-core.js";
import { LlmRequestTimeoutError } from "../../src/utils/llm-fetch.js";
import { LoggerService } from "../../src/services/logger.service.js";

class TestProvider extends AiProviderCore {
  request(timeoutMs = 100) {
    this._requestTimeoutMs = timeoutMs;
    return this._createTokenGatedFetch("openai-compatible");
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe("local generation timeout", () => {
  async function withServer(handler: http.RequestListener, test: (url: string) => Promise<void>) {
    for (const method of ["info", "warn", "error"] as const) vi.spyOn(LoggerService.getInstance(), method).mockImplementation(() => {});
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await test(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }

  it("keeps the deadline active after headers and retries only once", async () => {
    let calls = 0;
    await withServer((_req, res) => { calls++; res.writeHead(200); res.flushHeaders(); res.write("{"); }, async url => {
      await expect(new TestProvider().request(80)(url, { method: "POST" })).rejects.toBeInstanceOf(LlmRequestTimeoutError);
      expect(calls).toBe(2);
      expect(LoggerService.getInstance().warn).toHaveBeenCalledWith("Model request failed", expect.objectContaining({ failureType: "response_timeout" }));
    });
  });

  it("removes cancellation listeners after success and preserves response content", async () => {
    await withServer((_req, res) => { res.setHeader("X-Test", "yes"); res.end('{"ok":true}'); }, async url => {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const request = new TestProvider().request(1000);
      const response = await request(url, { method: "POST", signal: controller.signal });
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get("X-Test")).toBe("yes");
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });

  it("does not retry user cancellation", async () => {
    let calls = 0;
    await withServer(() => { calls++; }, async url => {
      const controller = new AbortController();
      const pending = new TestProvider().request(1000)(url, { method: "POST", signal: controller.signal });
      const check = expect(pending).rejects.toThrow("user stopped");
      setTimeout(() => controller.abort(new Error("user stopped")), 50);
      await check;
      expect(calls).toBe(1);
    });
  });

  it("logs the underlying transport error code", async () => {
    const cause = Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    vi.spyOn(LoggerService.getInstance(), "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed", { cause }));
    await expect(new TestProvider().request()("http://example.test", { method: "POST" })).rejects.toThrow("fetch failed");
    expect(LoggerService.getInstance().warn).toHaveBeenCalledWith("Model request failed", expect.objectContaining({
      failureType: "transport",
      errorCauses: expect.arrayContaining([expect.objectContaining({ code: "UND_ERR_HEADERS_TIMEOUT" })]),
    }));
  });

  it("repairs malformed Unicode in persisted history before sending JSON", async () => {
    let received: Record<string, any> | undefined;
    await withServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        received = JSON.parse(body) as Record<string, any>;
        res.end('{"ok":true}');
      });
    }, async url => {
      const body = JSON.stringify({
        model: "local",
        messages: [{ role: "tool", tool_call_id: "inspect", content: "\udf3f note \ud83c" }],
        metadata: {
          validEmoji: "\ud83c\udf3f",
          literalEscape: "\\udf3f",
          ["key\ud800"]: "value",
        },
      });
      const init: RequestInit = { method: "POST", body };
      const response = await new TestProvider().request(1000)(url, init);
      expect(response.status).toBe(200);
      expect(init.body).toBe(body);
      expect(received?.messages[0].content).toBe("\ufffd note \ufffd");
      expect(received?.metadata).toEqual({
        validEmoji: "\ud83c\udf3f",
        literalEscape: "\\udf3f",
        ["key\ufffd"]: "value",
      });
      expect(LoggerService.getInstance().warn).toHaveBeenCalledWith(
        "Normalized malformed Unicode in model request",
        expect.objectContaining({ provider: "openai-compatible" }),
      );
    });
  });

  it("preserves well-formed request bytes and escaped literal text", async () => {
    let received = "";
    await withServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", chunk => { received += chunk; });
      req.on("end", () => { res.end('{"ok":true}'); });
    }, async url => {
      const body = '{ "messages": [{ "role": "user", "content": "\\ud83c\\udf3f literal \\\\udf3f" }] }';
      await new TestProvider().request(1000)(url, { method: "POST", body });
      expect(received).toBe(body);
      expect(LoggerService.getInstance().warn).not.toHaveBeenCalledWith(
        "Normalized malformed Unicode in model request", expect.anything(),
      );
    });
  });

  it("rejects Unicode key collisions without sending a lossy request", async () => {
    let calls = 0;
    await withServer((_req, res) => { calls++; res.end('{"ok":true}'); }, async url => {
      const body = JSON.stringify({ metadata: { ["\ud800"]: "first", ["\ud801"]: "second" } });
      await expect(new TestProvider().request(1000)(url, { method: "POST", body }))
        .rejects.toThrow("Malformed Unicode creates duplicate JSON keys");
      expect(calls).toBe(0);
    });
  });

});
