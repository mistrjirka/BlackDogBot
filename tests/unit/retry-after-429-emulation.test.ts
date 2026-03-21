import { describe, expect, it } from "vitest";
import { APICallError } from "ai";

import { resolve429Backoff } from "../../src/utils/retry-after.js";

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

describe("resolve429Backoff emulated 429 handling", () => {
  it("applies +10% margin to Retry-After header", () => {
    const error: APICallError = create429Error({
      responseHeaders: { "Retry-After": "15" },
    });

    const decision = resolve429Backoff(error, 1);

    expect(decision.source).toBe("retry-after");
    expect(decision.waitMs).toBe(16_500);
  });

  it("applies +10% margin to X-RateLimit-Reset header", () => {
    const resetAtMs: number = Date.now() + 20_000;
    const error: APICallError = create429Error({
      responseHeaders: { "X-RateLimit-Reset": String(resetAtMs) },
    });

    const decision = resolve429Backoff(error, 1);

    expect(decision.source).toBe("rate-limit-reset");
    expect(decision.waitMs).toBeGreaterThanOrEqual(21_000);
    expect(decision.waitMs).toBeLessThanOrEqual(22_500);
  });

  it("uses the larger explicit value and then applies +10% margin when both headers are present", () => {
    const resetAtMs: number = Date.now() + 20_000;
    const error: APICallError = create429Error({
      responseHeaders: {
        "Retry-After": "15",
        "X-RateLimit-Reset": String(resetAtMs),
      },
    });

    const decision = resolve429Backoff(error, 1);

    expect(decision.source).toBe("retry-after+rate-limit-reset");
    expect(decision.waitMs).toBeGreaterThanOrEqual(21_000);
    expect(decision.waitMs).toBeLessThanOrEqual(22_500);
  });

  it("falls back to adaptive backoff when no explicit headers are present", () => {
    const error: APICallError = create429Error();

    const decision = resolve429Backoff(error, 1);

    expect(decision.source).toBe("adaptive");
    expect(decision.waitMs).toBe(10_000);
  });

  it("falls back to adaptive backoff when Retry-After is negative", () => {
    const error: APICallError = create429Error({
      responseHeaders: { "Retry-After": "-15" },
    });

    const decision = resolve429Backoff(error, 1);

    expect(decision.source).toBe("adaptive");
    expect(decision.waitMs).toBe(10_000);
  });

  it("falls back to adaptive backoff when Retry-After is zero", () => {
    const error: APICallError = create429Error({
      responseHeaders: { "Retry-After": "0" },
    });

    const decision = resolve429Backoff(error, 1);

    expect(decision.source).toBe("adaptive");
    expect(decision.waitMs).toBe(10_000);
  });
});
