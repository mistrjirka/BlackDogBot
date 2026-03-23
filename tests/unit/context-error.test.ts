import { describe, expect, it } from "vitest";
import { APICallError } from "ai";

import {
  getConnectionRetryDelayMs,
  isConnectionError,
  isRetryableApiError,
  MAX_CONNECTION_RETRIES,
} from "../../src/utils/context-error.js";

describe("context-error helpers", () => {
  it("detects connection errors from plain Error messages", () => {
    const error: Error = new Error("Cannot connect to API: socket hang up");

    expect(isConnectionError(error)).toBe(true);
  });

  it("detects connection errors from APICallError messages", () => {
    const error: APICallError = new APICallError({
      message: "fetch failed ECONNREFUSED",
      url: "http://localhost:2345/v1/chat/completions",
      requestBodyValues: { model: "qwen3.5:latest" },
      isRetryable: true,
    });

    expect(isConnectionError(error)).toBe(true);
  });

  it("keeps non-connection parse retry behavior unchanged", () => {
    const error: Error = new Error("invalid json response from provider");

    expect(isRetryableApiError(error)).toBe(true);
    expect(isConnectionError(error)).toBe(false);
  });

  it("returns exponential retry delays for connection retries", () => {
    expect(MAX_CONNECTION_RETRIES).toBe(5);
    expect(getConnectionRetryDelayMs(1)).toBe(10_000);
    expect(getConnectionRetryDelayMs(2)).toBe(20_000);
    expect(getConnectionRetryDelayMs(3)).toBe(40_000);
    expect(getConnectionRetryDelayMs(4)).toBe(80_000);
    expect(getConnectionRetryDelayMs(5)).toBe(160_000);
  });
});
