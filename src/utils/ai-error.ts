import { APICallError } from "ai";
import { extractErrorMessage } from "./error.js";

//#region Interfaces

export interface IAiErrorDetails {
  message: string;
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
 * If the error is an `APICallError` from the `ai` package, all available
 * fields (status code, response body, URL, retryable flag) are returned.
 * For any other error type, only the message is populated.
 */
export function extractAiErrorDetails(error: unknown): IAiErrorDetails {
  const details: IAiErrorDetails = {
    message: extractErrorMessage(error),
    provider: null,
    model: null,
    statusCode: null,
    responseBody: null,
    isRetryable: null,
    url: null,
  };

  if (APICallError.isInstance(error)) {
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
  }

  return details;
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

    parts.push(`Details: ${details.message}`);
  } else {
    parts.push(`An error occurred: ${details.message}`);
  }

  return parts.join("\n");
}

//#endregion Public functions
