import { extractAiErrorDetails, type IAiErrorDetails } from "./ai-error.js";

const CONTEXT_ERROR_STATUS_CODES: number[] = [400, 413, 422, 500];
const CONTEXT_ERROR_KEYWORDS: string[] = [
  "context",
  "context size",
  "token limit",
  "exceeded",
  "too long",
  "length",
];

const RETRYABLE_PARSE_ERROR_KEYWORDS: string[] = [
  "invalid json response",
  "json parsing failed",
  "unexpected token",
  "unexpected end of json input",
  "failed to parse",
  "invalid input for tool",
  "could not parse the response",
];

const CONNECTION_ERROR_KEYWORDS: string[] = [
  "cannot connect to api",
  "cannot connect",
  "connection refused",
  "connection reset",
  "econnrefused",
  "econnreset",
  "etimedout",
  "network error",
  "fetch failed",
  "socket hang up",
  "request timed out",
  "timed out",
];

const CONNECTION_RETRY_INITIAL_DELAY_MS: number = 10_000;
const CONNECTION_RETRY_MULTIPLIER: number = 2;

export const MAX_CONNECTION_RETRIES: number = 5;

interface IAPICallErrorLike extends Error {
  statusCode?: number | null;
  responseBody?: string | null;
  isRetryable?: boolean | null;
}

function _isAPICallError(error: unknown): error is IAPICallErrorLike {
  if (error instanceof Error && "statusCode" in error) {
    return true;
  }
  return false;
}

function _hasRetryableParseErrorName(error: unknown): boolean {
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    return name === "invalidtoolinputerror" || name === "jsonparseerror";
  }
  return false;
}

export function isContextExceededApiError(error: unknown): boolean {
  if (!_isAPICallError(error)) {
    return false;
  }

  if (!CONTEXT_ERROR_STATUS_CODES.includes(error.statusCode ?? 0)) {
    return false;
  }

  const responseBody: string = typeof error.responseBody === "string"
    ? error.responseBody
    : JSON.stringify(error.responseBody ?? "");
  const errorMessage: string = error.message ?? "";
  const combined: string = `${responseBody} ${errorMessage}`.toLowerCase();

  return CONTEXT_ERROR_KEYWORDS.some((keyword: string): boolean => combined.includes(keyword));
}

export function isRetryableApiError(error: unknown): boolean {
  if (_hasRetryableParseErrorName(error)) {
    return true;
  }

  if (_isAPICallError(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return false;
    }

    if (error.isRetryable === true) {
      return true;
    }

    if (error.statusCode === 200 || error.statusCode === null || error.statusCode === undefined) {
      return true;
    }

    const responseBody: string = typeof error.responseBody === "string"
      ? error.responseBody
      : JSON.stringify(error.responseBody ?? "");
    const combined: string = `${error.message ?? ""} ${responseBody}`.toLowerCase();

    return _hasRetryableParseErrorKeyword(combined);
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const combinedMessage: string = `${error.name} ${error.message}`.toLowerCase();
  return _hasRetryableParseErrorKeyword(combinedMessage);
}

export function isConnectionError(error: unknown): boolean {
  if (_isAPICallError(error)) {
    const responseBody: string = typeof error.responseBody === "string"
      ? error.responseBody
      : JSON.stringify(error.responseBody ?? "");
    const combined: string = `${error.message ?? ""} ${responseBody}`.toLowerCase();
    return _hasConnectionErrorKeyword(combined);
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const combinedMessage: string = `${error.name} ${error.message}`.toLowerCase();
  return _hasConnectionErrorKeyword(combinedMessage);
}

export function getConnectionRetryDelayMs(retryAttempt: number): number {
  const normalizedAttempt: number = Math.max(1, retryAttempt);
  return CONNECTION_RETRY_INITIAL_DELAY_MS * Math.pow(CONNECTION_RETRY_MULTIPLIER, normalizedAttempt - 1);
}

function _hasRetryableParseErrorKeyword(input: string): boolean {
  return RETRYABLE_PARSE_ERROR_KEYWORDS.some((keyword: string): boolean => input.includes(keyword));
}

function _hasConnectionErrorKeyword(input: string): boolean {
  return CONNECTION_ERROR_KEYWORDS.some((keyword: string): boolean => input.includes(keyword));
}

export function isContextExceededTelegramError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const details: IAiErrorDetails = extractAiErrorDetails(error);
  const combined: string = `${details.message ?? ""} ${details.providerMessage ?? ""} ${details.responseBody ?? ""}`.toLowerCase();

  if (details.statusCode === 400 && combined.includes("context") && combined.includes("exceeded")) {
    return true;
  }

  return combined.includes("context_length_exceeded") ||
    (combined.includes("context") && combined.includes("token") && combined.includes("limit"));
}
