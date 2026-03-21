import { APICallError } from "ai";

const CONTEXT_ERROR_STATUS_CODES: number[] = [400, 413, 422, 500];
const CONTEXT_ERROR_KEYWORDS: string[] = [
  "context",
  "context size",
  "token limit",
  "exceeded",
  "too long",
  "length",
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
