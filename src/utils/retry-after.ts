import { APICallError } from "ai";

const DEFAULT_429_BACKOFF_MS: number = 10_000;
const MAX_RETRY_AFTER_MS: number = 120_000;
const EXPLICIT_429_SAFETY_MULTIPLIER: number = 1.1;

export interface I429BackoffDecision {
  waitMs: number;
  source: "retry-after" | "rate-limit-reset" | "retry-after+rate-limit-reset" | "adaptive";
  retryAfterMs: number | null;
  rateLimitResetMs: number | null;
  retryAfterSource:
    | "header:retry-after-ms"
    | "header:retry-after"
    | "body:openrouter.metadata.headers.retry-after"
    | "none";
  rateLimitResetSource:
    | "header:x-ratelimit-reset"
    | "header:x-ratelimit-reset-requests"
    | "body:openrouter.metadata.headers.x-ratelimit-reset"
    | "none";
}

interface IRetryAfterExtraction {
  waitMs: number | null;
  source:
    | "header:retry-after-ms"
    | "header:retry-after"
    | "body:openrouter.metadata.headers.retry-after"
    | "none";
}

interface IRateLimitResetExtraction {
  waitMs: number | null;
  source:
    | "header:x-ratelimit-reset"
    | "header:x-ratelimit-reset-requests"
    | "body:openrouter.metadata.headers.x-ratelimit-reset"
    | "none";
}

/**
 * Extracts the Retry-After delay in milliseconds from an APICallError with status 429.
 *
 * Checks (in priority order):
 * 1. `retry-after-ms` header (milliseconds, used by some OpenAI-compatible providers)
 * 2. `Retry-After` header (standard HTTP: seconds or HTTP-date)
 * 3. OpenRouter: `error.metadata.headers.Retry-After` in the JSON response body
 *
 * Returns `null` if the error is not a 429 or no retry-after info is found.
 */
export function extractRetryAfterMs(error: unknown): number | null {
  return extractRetryAfterDecision(error).waitMs;
}

function extractRetryAfterDecision(error: unknown): IRetryAfterExtraction {
  if (!APICallError.isInstance(error) || error.statusCode !== 429) {
    return { waitMs: null, source: "none" };
  }

  const headers: Record<string, string> | undefined = error.responseHeaders;

  // 1. retry-after-ms header (most precise)
  if (headers) {
    const retryAfterMs: string | undefined =
      headers["retry-after-ms"] ?? headers["Retry-After-Ms"];

    if (retryAfterMs) {
      const ms: number = parseFloat(retryAfterMs);

      if (!Number.isNaN(ms) && ms > 0) {
        return {
          waitMs: Math.min(ms, MAX_RETRY_AFTER_MS),
          source: "header:retry-after-ms",
        };
      }
    }

    // 2. Standard Retry-After header (seconds or HTTP-date)
    const retryAfter: string | undefined =
      headers["retry-after"] ?? headers["Retry-After"];

    if (retryAfter) {
      const seconds: number = parseFloat(retryAfter);

      if (!Number.isNaN(seconds) && seconds > 0) {
        return {
          waitMs: Math.min(seconds * 1000, MAX_RETRY_AFTER_MS),
          source: "header:retry-after",
        };
      }

      // HTTP-date format
      const dateMs: number = Date.parse(retryAfter);

      if (!Number.isNaN(dateMs)) {
        const delay: number = dateMs - Date.now();

        if (delay > 0) {
          return {
            waitMs: Math.min(delay, MAX_RETRY_AFTER_MS),
            source: "header:retry-after",
          };
        }
      }
    }
  }

  // 3. OpenRouter: Retry-After in response body metadata
  if (typeof error.responseBody === "string") {
    const openRouterMs: number | null = _parseOpenRouterRetryAfter(error.responseBody);

    if (openRouterMs !== null) {
      return {
        waitMs: openRouterMs,
        source: "body:openrouter.metadata.headers.retry-after",
      };
    }
  }

  return { waitMs: null, source: "none" };
}

export function extractRateLimitResetMs(error: unknown): number | null {
  return extractRateLimitResetDecision(error).waitMs;
}

function extractRateLimitResetDecision(error: unknown): IRateLimitResetExtraction {
  if (!APICallError.isInstance(error) || error.statusCode !== 429) {
    return { waitMs: null, source: "none" };
  }

  const headers: Record<string, string> | undefined = error.responseHeaders;
  const headerRateLimitReset: string | undefined = headers
    ? (headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"])
    : undefined;
  const parsedFromRateLimitResetHeader: number | null = _parseResetValueToDelayMs(headerRateLimitReset);
  if (parsedFromRateLimitResetHeader !== null) {
    return {
      waitMs: parsedFromRateLimitResetHeader,
      source: "header:x-ratelimit-reset",
    };
  }

  const headerRateLimitResetRequests: string | undefined = headers
    ? (headers["x-ratelimit-reset-requests"] ?? headers["X-RateLimit-Reset-Requests"])
    : undefined;
  const parsedFromRateLimitResetRequestsHeader: number | null = _parseResetValueToDelayMs(headerRateLimitResetRequests);
  if (parsedFromRateLimitResetRequestsHeader !== null) {
    return {
      waitMs: parsedFromRateLimitResetRequestsHeader,
      source: "header:x-ratelimit-reset-requests",
    };
  }

  if (typeof error.responseBody === "string") {
    const parsedFromBody: number | null = _parseOpenRouterRateLimitReset(error.responseBody);
    if (parsedFromBody !== null) {
      return {
        waitMs: parsedFromBody,
        source: "body:openrouter.metadata.headers.x-ratelimit-reset",
      };
    }
  }

  return { waitMs: null, source: "none" };
}

export function resolve429Backoff(error: unknown, retryAttempt: number): I429BackoffDecision {
  const retryAfter: IRetryAfterExtraction = extractRetryAfterDecision(error);
  const rateLimitReset: IRateLimitResetExtraction = extractRateLimitResetDecision(error);
  const retryAfterMs: number | null = retryAfter.waitMs;
  const rateLimitResetMs: number | null = rateLimitReset.waitMs;

  if (retryAfterMs !== null && rateLimitResetMs !== null) {
    const explicitWaitMs: number = Math.max(retryAfterMs, rateLimitResetMs);

    return {
      waitMs: _applyExplicit429SafetyMargin(explicitWaitMs),
      source: "retry-after+rate-limit-reset",
      retryAfterMs,
      rateLimitResetMs,
      retryAfterSource: retryAfter.source,
      rateLimitResetSource: rateLimitReset.source,
    };
  }

  if (retryAfterMs !== null) {
    return {
      waitMs: _applyExplicit429SafetyMargin(retryAfterMs),
      source: "retry-after",
      retryAfterMs,
      rateLimitResetMs,
      retryAfterSource: retryAfter.source,
      rateLimitResetSource: rateLimitReset.source,
    };
  }

  if (rateLimitResetMs !== null) {
    return {
      waitMs: _applyExplicit429SafetyMargin(rateLimitResetMs),
      source: "rate-limit-reset",
      retryAfterMs,
      rateLimitResetMs,
      retryAfterSource: retryAfter.source,
      rateLimitResetSource: rateLimitReset.source,
    };
  }

  const safeAttempt: number = Math.max(1, retryAttempt);
  const adaptiveBackoffMs: number = Math.min(
    DEFAULT_429_BACKOFF_MS * Math.pow(2, safeAttempt - 1),
    MAX_RETRY_AFTER_MS,
  );

  return {
    waitMs: adaptiveBackoffMs,
    source: "adaptive",
    retryAfterMs,
    rateLimitResetMs,
    retryAfterSource: retryAfter.source,
    rateLimitResetSource: rateLimitReset.source,
  };
}

function _applyExplicit429SafetyMargin(waitMs: number): number {
  const safeWaitMs: number = Math.ceil(waitMs * EXPLICIT_429_SAFETY_MULTIPLIER);
  return Math.min(safeWaitMs, MAX_RETRY_AFTER_MS);
}

function _parseOpenRouterRetryAfter(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const error: unknown = (parsed as Record<string, unknown>)["error"];

    if (typeof error !== "object" || error === null) {
      return null;
    }

    const metadata: unknown = (error as Record<string, unknown>)["metadata"];

    if (typeof metadata !== "object" || metadata === null) {
      return null;
    }

    const headers: unknown = (metadata as Record<string, unknown>)["headers"];

    if (typeof headers !== "object" || headers === null) {
      return null;
    }

    const retryAfter: unknown = (headers as Record<string, unknown>)["Retry-After"] ??
      (headers as Record<string, unknown>)["retry-after"];

    if (typeof retryAfter === "number" && retryAfter > 0) {
      return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
    }

    if (typeof retryAfter === "string") {
      const ms: number = parseFloat(retryAfter);

      if (!Number.isNaN(ms) && ms > 0) {
        return Math.min(ms * 1000, MAX_RETRY_AFTER_MS);
      }
    }

    return null;
  } catch {
    return null;
  }
}

function _parseOpenRouterRateLimitReset(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const error: unknown = (parsed as Record<string, unknown>)["error"];

    if (typeof error !== "object" || error === null) {
      return null;
    }

    const metadata: unknown = (error as Record<string, unknown>)["metadata"];

    if (typeof metadata !== "object" || metadata === null) {
      return null;
    }

    const headers: unknown = (metadata as Record<string, unknown>)["headers"];

    if (typeof headers !== "object" || headers === null) {
      return null;
    }

    const resetValue: unknown =
      (headers as Record<string, unknown>)["X-RateLimit-Reset"] ??
      (headers as Record<string, unknown>)["x-ratelimit-reset"] ??
      (headers as Record<string, unknown>)["X-RateLimit-Reset-Requests"] ??
      (headers as Record<string, unknown>)["x-ratelimit-reset-requests"];

    if (typeof resetValue !== "string" && typeof resetValue !== "number") {
      return null;
    }

    return _parseResetValueToDelayMs(String(resetValue));
  } catch {
    return null;
  }
}

function _parseResetValueToDelayMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const trimmed: string = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const numeric: number = Number.parseFloat(trimmed);

  if (!Number.isNaN(numeric) && Number.isFinite(numeric) && numeric > 0) {
    let delayMs: number;

    // Epoch milliseconds
    if (numeric >= 1_000_000_000_000) {
      delayMs = numeric - Date.now();
    }
    // Epoch seconds
    else if (numeric >= 1_000_000_000) {
      delayMs = (numeric * 1000) - Date.now();
    }
    // Relative seconds (fallback for non-standard providers)
    else {
      delayMs = numeric * 1000;
    }

    if (delayMs > 0) {
      return Math.min(delayMs, MAX_RETRY_AFTER_MS);
    }

    return null;
  }

  const parsedDateMs: number = Date.parse(trimmed);

  if (!Number.isNaN(parsedDateMs)) {
    const delayMs: number = parsedDateMs - Date.now();
    if (delayMs > 0) {
      return Math.min(delayMs, MAX_RETRY_AFTER_MS);
    }
  }

  return null;
}
