import { describe, expect, it } from "vitest";
import { APICallError } from "ai";

import {
  getConnectionRetryDelayMs,
  isConnectionError,
  isContextExceededTelegramError,
  isLlamaCppParseError,
  getDisableThinkingOnRetry,
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

describe("isLlamaCppParseError", () => {
  it("returns true for status 500 with failed to parse input", () => {
    const error: APICallError = new APICallError({
      message: "failed to parse input",
      url: "http://localhost:11434/v1/chat/completions",
      requestBodyValues: { model: "qwen3.5:latest" },
      statusCode: 500,
      isRetryable: true,
    });

    expect(isLlamaCppParseError(error)).toBe(true);
  });

  it("returns false for status 500 with context keywords", () => {
    const error: APICallError = new APICallError({
      message: "failed to parse input: context size exceeded",
      url: "http://localhost:11434/v1/chat/completions",
      requestBodyValues: { model: "qwen3.5:latest" },
      statusCode: 500,
      isRetryable: true,
    });

    expect(isLlamaCppParseError(error)).toBe(false);
  });

  it("returns false for status 500 with context limit keyword", () => {
    const error: APICallError = new APICallError({
      message: "failed to parse input",
      url: "http://localhost:11434/v1/chat/completions",
      requestBodyValues: { model: "qwen3.5:latest" },
      statusCode: 500,
      responseBody: '{"error": "context limit reached"}',
      isRetryable: true,
    });

    expect(isLlamaCppParseError(error)).toBe(false);
  });

  it("returns false for other status codes", () => {
    const error: APICallError = new APICallError({
      message: "failed to parse input",
      url: "http://localhost:11434/v1/chat/completions",
      requestBodyValues: { model: "qwen3.5:latest" },
      statusCode: 400,
      isRetryable: true,
    });

    expect(isLlamaCppParseError(error)).toBe(false);
  });

  it("returns true for plain Error with failed to parse input and 500", () => {
    const error: Error = new Error("500: failed to parse input");

    expect(isLlamaCppParseError(error)).toBe(true);
  });

  it("returns false for plain Error with context exceeded", () => {
    const error: Error = new Error("500: failed to parse input context exceeded");

    expect(isLlamaCppParseError(error)).toBe(false);
  });
});

describe("isContextExceededTelegramError", () => {
  it("returns true for context_length_exceeded error", () => {
    const error: Error = new Error("context_length_exceeded");

    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("returns true for status 400 with context and exceeded", () => {
    const error: APICallError = new APICallError({
      message: "context exceeded",
      url: "http://localhost:8080/v1/chat/completions",
      requestBodyValues: { model: "qwen3.5:latest" },
      statusCode: 400,
      isRetryable: false,
    });

    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("returns true for context token limit combination", () => {
    const error: Error = new Error("context token limit reached");

    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("returns false for other errors", () => {
    const error: Error = new Error("something went wrong");

    expect(isContextExceededTelegramError(error)).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isContextExceededTelegramError("context_length_exceeded")).toBe(false);
    expect(isContextExceededTelegramError(null)).toBe(false);
    expect(isContextExceededTelegramError(undefined)).toBe(false);
  });
});

describe("getDisableThinkingOnRetry", () => {
  it("returns true when qwen3_5 profile has disableThinkingOnRetry true", () => {
    expect(getDisableThinkingOnRetry()).toBe(true);
  });
});
