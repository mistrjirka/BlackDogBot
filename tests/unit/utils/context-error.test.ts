import { describe, expect, it } from "vitest";
import {
  getConnectionRetryDelayMs,
  isConnectionError,
  isContextExceededApiError,
  isContextExceededTelegramError,
  isLlamaCppParseError,
  isRetryableApiError,
  MAX_CONNECTION_RETRIES,
} from "../../../src/utils/context-error.js";

describe("isContextExceededTelegramError", () => {
  it("should return true when statusCode is 400 and combined includes context and exceeded", () => {
    const error = new Error("context exceeded") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 400;
    error.responseBody = "context limit exceeded";
    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("should return true when combined includes context_length_exceeded", () => {
    const error = new Error("some error") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 400;
    error.responseBody = "context_length_exceeded";
    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("should return true when combined includes context, token, and limit", () => {
    const error = new Error("context") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 500;
    error.responseBody = "token limit reached";
    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("should return false for unrelated errors", () => {
    const error = new Error("something went wrong") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 500;
    error.responseBody = "internal server error";
    expect(isContextExceededTelegramError(error)).toBe(false);
  });

  it("should return false when statusCode is 400 but no context exceeded keywords", () => {
    const error = new Error("bad request") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 400;
    error.responseBody = "invalid request";
    expect(isContextExceededTelegramError(error)).toBe(false);
  });

  it("should handle errors with providerMessage extracted from responseBody", () => {
    const error = new Error("error") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 400;
    error.responseBody = JSON.stringify({ error: { message: "context exceeded" } });
    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("should be case insensitive", () => {
    const error = new Error("CONTEXT EXCEEDED") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 400;
    error.responseBody = "";
    expect(isContextExceededTelegramError(error)).toBe(true);
  });

  it("should return false for non-error input", () => {
    expect(isContextExceededTelegramError("context exceeded")).toBe(false);
  });
});

describe("isContextExceededApiError", () => {
  it("returns true for API context-limit style errors", () => {
    const error = new Error("request too long") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 413;
    error.responseBody = "context length exceeded";
    expect(isContextExceededApiError(error)).toBe(true);
  });

  it("returns false for non-api errors", () => {
    expect(isContextExceededApiError(new Error("plain error"))).toBe(false);
  });
});

describe("isRetryableApiError", () => {
  it("returns true for retryable parse error names", () => {
    const error = new Error("bad parse");
    error.name = "JSONParseError";
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns false for unauthorized API errors", () => {
    const error = new Error("unauthorized") as Error & { statusCode: number; responseBody: string };
    error.statusCode = 401;
    error.responseBody = "forbidden";
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("returns true when explicit isRetryable is set", () => {
    const error = new Error("retry me") as Error & { statusCode: number; isRetryable: boolean };
    error.statusCode = 500;
    error.isRetryable = true;
    expect(isRetryableApiError(error)).toBe(true);
  });
});

describe("isConnectionError", () => {
  it("returns true for connection keyword in message", () => {
    const error = new Error("ECONNREFUSED while connecting");
    expect(isConnectionError(error)).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    const error = new Error("validation failed");
    expect(isConnectionError(error)).toBe(false);
  });
});

describe("getConnectionRetryDelayMs", () => {
  it("uses exponential backoff with base 10s", () => {
    expect(getConnectionRetryDelayMs(1)).toBe(10_000);
    expect(getConnectionRetryDelayMs(2)).toBe(20_000);
    expect(getConnectionRetryDelayMs(3)).toBe(40_000);
  });

  it("normalizes attempts below 1", () => {
    expect(getConnectionRetryDelayMs(0)).toBe(10_000);
    expect(getConnectionRetryDelayMs(-4)).toBe(10_000);
  });
});

describe("MAX_CONNECTION_RETRIES", () => {
  it("is set to expected default", () => {
    expect(MAX_CONNECTION_RETRIES).toBe(5);
  });
});

describe("isLlamaCppParseError", () => {
  it("returns true for 500 with 'Failed to parse input' in response body", () => {
    const error = Object.assign(new Error("Request failed"), {
      statusCode: 500,
      responseBody: '{"error":{"code":500,"message":"Failed to parse input at pos 233","type":"server_error"}}',
    });
    expect(isLlamaCppParseError(error)).toBe(true);
  });

  it("returns true when error message contains 'failed to parse input'", () => {
    const error = Object.assign(new Error("500 Failed to parse input at pos 233"), {
      statusCode: 500,
      responseBody: "some body",
    });
    expect(isLlamaCppParseError(error)).toBe(true);
  });

  it("returns false for 500 with context keywords (context error, not parse error)", () => {
    const error = Object.assign(new Error("Request failed"), {
      statusCode: 500,
      responseBody: '{"error":{"code":500,"message":"context size exceeded","type":"server_error"}}',
    });
    expect(isLlamaCppParseError(error)).toBe(false);
  });

  it("returns false for non-500 errors", () => {
    const error = Object.assign(new Error("Request failed"), {
      statusCode: 400,
      responseBody: "Failed to parse input",
    });
    expect(isLlamaCppParseError(error)).toBe(false);
  });

  it("returns false for plain errors without statusCode", () => {
    const error = new Error("something went wrong");
    expect(isLlamaCppParseError(error)).toBe(false);
  });
});
