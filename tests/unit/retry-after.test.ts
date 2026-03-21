import { describe, it, expect } from "vitest";
import { APICallError } from "ai";

import { extractRetryAfterMs, extractRateLimitResetMs, resolve429Backoff } from "../../src/utils/retry-after.js";

function create429Error(args?: {
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}): APICallError {
  const error: APICallError = new APICallError({
    message: "Rate limited",
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: { model: "stepfun/step-3.5-flash:free" },
    statusCode: 429,
    responseBody: args?.responseBody,
    isRetryable: true,
  });

  if (args?.responseHeaders) {
    (error as unknown as { responseHeaders: Record<string, string> }).responseHeaders = args.responseHeaders;
  }

  return error;
}

describe("retry-after helpers", () => {
  it("extracts Retry-After header in seconds", () => {
    const error: APICallError = create429Error({
      responseHeaders: { "Retry-After": "12" },
    });

    const waitMs: number | null = extractRetryAfterMs(error);
    expect(waitMs).toBe(12000);
  });

  it("extracts X-RateLimit-Reset header as epoch milliseconds", () => {
    const targetDelayMs: number = 30000;
    const resetAtMs: number = Date.now() + targetDelayMs;

    const error: APICallError = create429Error({
      responseHeaders: { "X-RateLimit-Reset": String(resetAtMs) },
    });

    const waitMs: number | null = extractRateLimitResetMs(error);
    expect(waitMs).not.toBeNull();
    expect(waitMs!).toBeGreaterThanOrEqual(20000);
    expect(waitMs!).toBeLessThanOrEqual(30000);
  });

  it("extracts OpenRouter metadata.headers Retry-After from response body", () => {
    const error: APICallError = create429Error({
      responseBody: JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 429,
          metadata: {
            headers: {
              "Retry-After": "9",
            },
          },
        },
      }),
    });

    const waitMs: number | null = extractRetryAfterMs(error);
    expect(waitMs).toBe(9000);
  });

  it("resolve429Backoff prefers the larger explicit backoff when both are present", () => {
    const resetAtMs: number = Date.now() + 30000;
    const error: APICallError = create429Error({
      responseHeaders: {
        "Retry-After": "5",
        "X-RateLimit-Reset": String(resetAtMs),
      },
    });

    const decision = resolve429Backoff(error, 1);
    expect(decision.source).toBe("retry-after+rate-limit-reset");
    expect(decision.waitMs).toBeGreaterThanOrEqual(22000);
    expect(decision.waitMs).toBeLessThanOrEqual(33000);
    expect(decision.retryAfterSource).toBe("header:retry-after");
    expect(decision.rateLimitResetSource).toBe("header:x-ratelimit-reset");
  });

  it("resolve429Backoff uses adaptive exponential fallback when no explicit delay exists", () => {
    const error: APICallError = create429Error({
      responseBody: JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 429,
          metadata: {
            raw: "temporarily rate-limited upstream; retry shortly",
          },
        },
      }),
    });

    const firstDecision = resolve429Backoff(error, 1);
    const secondDecision = resolve429Backoff(error, 2);
    const thirdDecision = resolve429Backoff(error, 3);

    expect(firstDecision.source).toBe("adaptive");
    expect(firstDecision.waitMs).toBe(10000);
    expect(secondDecision.waitMs).toBe(20000);
    expect(thirdDecision.waitMs).toBe(40000);
    expect(firstDecision.retryAfterSource).toBe("none");
    expect(firstDecision.rateLimitResetSource).toBe("none");
  });

  it("resolve429Backoff reports retry-after-ms header source", () => {
    const error: APICallError = create429Error({
      responseHeaders: { "retry-after-ms": "7000" },
    });

    const decision = resolve429Backoff(error, 1);
    expect(decision.source).toBe("retry-after");
    expect(decision.retryAfterSource).toBe("header:retry-after-ms");
    expect(decision.waitMs).toBeGreaterThanOrEqual(7700);
    expect(decision.waitMs).toBeLessThanOrEqual(7701);
  });

  it("resolve429Backoff reports OpenRouter body retry-after source", () => {
    const error: APICallError = create429Error({
      responseBody: JSON.stringify({
        error: {
          metadata: {
            headers: {
              "Retry-After": "6",
            },
          },
        },
      }),
    });

    const decision = resolve429Backoff(error, 1);
    expect(decision.source).toBe("retry-after");
    expect(decision.retryAfterSource).toBe("body:openrouter.metadata.headers.retry-after");
    expect(decision.waitMs).toBeGreaterThanOrEqual(6600);
    expect(decision.waitMs).toBeLessThanOrEqual(6601);
  });

  it("resolve429Backoff reports x-ratelimit-reset-requests source", () => {
    const resetAtMs: number = Date.now() + 12_000;
    const error: APICallError = create429Error({
      responseHeaders: {
        "x-ratelimit-reset-requests": String(resetAtMs),
      },
    });

    const decision = resolve429Backoff(error, 1);
    expect(decision.source).toBe("rate-limit-reset");
    expect(decision.rateLimitResetSource).toBe("header:x-ratelimit-reset-requests");
    expect(decision.waitMs).toBeGreaterThanOrEqual(12_000);
  });
});
