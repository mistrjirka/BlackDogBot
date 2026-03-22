import { APICallError, InvalidToolInputError, JSONParseError } from "ai";

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

export function isContextExceededApiError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
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
  if (JSONParseError.isInstance(error) || InvalidToolInputError.isInstance(error)) {
    return true;
  }

  if (APICallError.isInstance(error)) {
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

function _hasRetryableParseErrorKeyword(input: string): boolean {
  return RETRYABLE_PARSE_ERROR_KEYWORDS.some((keyword: string): boolean => input.includes(keyword));
}
