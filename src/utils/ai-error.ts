import { extractErrorMessage } from "./error.js";

//#region Interfaces

interface IAPICallErrorLike {
  statusCode?: number | null;
  responseBody?: string | null;
  isRetryable?: boolean | null;
  url?: string | null;
  requestBodyValues?: Record<string, unknown> | null;
}

export interface IAiErrorDetails {
  message: string;
  providerMessage: string | null;
  provider: string | null;
  model: string | null;
  statusCode: number | null;
  responseBody: string | null;
  isRetryable: boolean | null;
  url: string | null;
}

//#endregion Interfaces

//#region Public functions

/**
 * Extracts structured error details from an AI SDK error.
 * If the error has the shape of an `APICallError` (statusCode, responseBody, etc.), all available
 * fields (status code, response body, URL, retryable flag) are returned.
 * For any other error type, only the message is populated.
 */
export function extractAiErrorDetails(error: unknown): IAiErrorDetails {
  const details: IAiErrorDetails = {
    message: extractErrorMessage(error),
    providerMessage: null,
    provider: null,
    model: null,
    statusCode: null,
    responseBody: null,
    isRetryable: null,
    url: null,
  };

  if (_isAPICallError(error)) {
    details.statusCode = error.statusCode ?? null;
    details.responseBody = error.responseBody ?? null;
    details.isRetryable = error.isRetryable ?? null;
    details.url = error.url ?? null;

    // Try to extract provider/model from the URL
    // OpenRouter URLs look like: https://openrouter.ai/api/v1/chat/completions
    if (error.url) {
      try {
        const parsedUrl: URL = new URL(error.url);
        details.provider = parsedUrl.hostname;
      } catch {
        // URL parsing failed, leave provider null
      }
    }

    // Try to extract model from requestBodyValues
    if (error.requestBodyValues && typeof error.requestBodyValues === "object") {
      const body = error.requestBodyValues as Record<string, unknown>;

      if (typeof body.model === "string") {
        details.model = body.model;
      }
    }

    details.providerMessage = _extractProviderMessageFromResponseBody(details.responseBody);
  }

  return details;
}

function _isAPICallError(error: unknown): error is IAPICallErrorLike {
  if (error instanceof Error && "statusCode" in error) {
    const err = error as IAPICallErrorLike;
    return (
      err.statusCode !== undefined ||
      err.responseBody !== undefined ||
      err.isRetryable !== undefined ||
      err.url !== undefined
    );
  }
  return false;
}

/**
 * Formats AI error details into a human-readable string suitable for logging.
 */
export function formatAiErrorForLog(details: IAiErrorDetails): string {
  const parts: string[] = [`AI API error: ${details.message}`];

  if (details.provider) {
    parts.push(`provider: ${details.provider}`);
  }

  if (details.model) {
    parts.push(`model: ${details.model}`);
  }

  if (details.statusCode !== null) {
    parts.push(`status: ${details.statusCode}`);
  }

  if (details.isRetryable !== null) {
    parts.push(`retryable: ${details.isRetryable}`);
  }

  if (details.responseBody) {
    parts.push(`response: ${details.responseBody}`);
  }

  return parts.join(" | ");
}

/**
 * Formats AI error details into a user-facing message suitable for Telegram.
 */
export function formatAiErrorForUser(details: IAiErrorDetails): string {
  const parts: string[] = [];
  const detailMessage: string = details.providerMessage ?? details.message;

  if (details.statusCode !== null) {
    if (details.statusCode === 401 || details.statusCode === 403) {
      parts.push("Authentication failed with the AI provider.");
    } else if (details.statusCode === 429) {
      parts.push("AI provider rate limit exceeded. Please try again in a moment.");
    } else if (details.statusCode >= 500) {
      parts.push("The AI provider is experiencing issues.");
    } else {
      parts.push(`AI provider returned an error (HTTP ${details.statusCode}).`);
    }

    if (details.provider) {
      parts.push(`Provider: ${details.provider}`);
    }

    if (details.model) {
      parts.push(`Model: ${details.model}`);
    }

    parts.push(`Details: ${detailMessage}`);
  } else {
    parts.push(`An error occurred: ${detailMessage}`);
  }

  return parts.join("\n");
}

function _extractProviderMessageFromResponseBody(responseBody: string | null): string | null {
  if (!responseBody) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const errorObject: unknown = (parsed as Record<string, unknown>).error;
    if (typeof errorObject !== "object" || errorObject === null) {
      return null;
    }

    const metadata: unknown = (errorObject as Record<string, unknown>).metadata;
    if (typeof metadata === "object" && metadata !== null) {
      const raw: unknown = (metadata as Record<string, unknown>).raw;
      if (typeof raw === "string" && raw.trim().length > 0) {
        return raw.trim();
      }
    }

    const providerMessage: unknown = (errorObject as Record<string, unknown>).message;
    if (typeof providerMessage === "string" && providerMessage.trim().length > 0) {
      return providerMessage.trim();
    }

    return null;
  } catch {
    return null;
  }
}

//#endregion Public functions
