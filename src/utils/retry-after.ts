import { APICallError } from "ai";

const DEFAULT_429_BACKOFF_MS: number = 10_000;
const MAX_RETRY_AFTER_MS: number = 120_000;

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
  if (!APICallError.isInstance(error) || error.statusCode !== 429) {
    return null;
  }

  const headers: Record<string, string> | undefined = error.responseHeaders;

  // 1. retry-after-ms header (most precise)
  if (headers) {
    const retryAfterMs: string | undefined =
      headers["retry-after-ms"] ?? headers["Retry-After-Ms"];

    if (retryAfterMs) {
      const ms: number = parseFloat(retryAfterMs);

      if (!Number.isNaN(ms) && ms > 0) {
        return Math.min(ms, MAX_RETRY_AFTER_MS);
      }
    }

    // 2. Standard Retry-After header (seconds or HTTP-date)
    const retryAfter: string | undefined =
      headers["retry-after"] ?? headers["Retry-After"];

    if (retryAfter) {
      const seconds: number = parseFloat(retryAfter);

      if (!Number.isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
      }

      // HTTP-date format
      const dateMs: number = Date.parse(retryAfter);

      if (!Number.isNaN(dateMs)) {
        const delay: number = dateMs - Date.now();

        if (delay > 0) {
          return Math.min(delay, MAX_RETRY_AFTER_MS);
        }
      }
    }
  }

  // 3. OpenRouter: Retry-After in response body metadata
  if (typeof error.responseBody === "string") {
    const openRouterMs: number | null = _parseOpenRouterRetryAfter(error.responseBody);

    if (openRouterMs !== null) {
      return openRouterMs;
    }
  }

  return null;
}

/**
 * Returns the default backoff for 429 errors when no Retry-After header is present.
 */
export function getDefault429BackoffMs(): number {
  return DEFAULT_429_BACKOFF_MS;
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
