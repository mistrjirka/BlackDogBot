import { describe, it, expect } from "vitest";
import { APICallError } from "ai";

import {
  extractAiErrorDetails,
  formatAiErrorForLog,
  formatAiErrorForUser,
  type IAiErrorDetails,
} from "../../src/utils/ai-error.js";

//#region Tests

describe("extractAiErrorDetails", () => {
  it("should extract full details from an APICallError", () => {
    // Arrange
    const error: APICallError = new APICallError({
      message: "User not found.",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: { model: "minimax/minimax-m2.5", messages: [] },
      statusCode: 401,
      responseBody: '{"error":{"message":"User not found."}}',
      isRetryable: false,
    });

    // Act
    const details: IAiErrorDetails = extractAiErrorDetails(error);

    // Assert
    expect(details.message).toBe("User not found.");
    expect(details.providerMessage).toBe("User not found.");
    expect(details.statusCode).toBe(401);
    expect(details.responseBody).toBe('{"error":{"message":"User not found."}}');
    expect(details.isRetryable).toBe(false);
    expect(details.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(details.provider).toBe("openrouter.ai");
    expect(details.model).toBe("minimax/minimax-m2.5");
  });

  it("should handle a plain Error with only a message", () => {
    // Arrange
    const error: Error = new Error("something went wrong");

    // Act
    const details: IAiErrorDetails = extractAiErrorDetails(error);

    // Assert
    expect(details.message).toBe("something went wrong");
    expect(details.providerMessage).toBeNull();
    expect(details.statusCode).toBeNull();
    expect(details.responseBody).toBeNull();
    expect(details.isRetryable).toBeNull();
    expect(details.url).toBeNull();
    expect(details.provider).toBeNull();
    expect(details.model).toBeNull();
  });

  it("should handle a non-Error value (string)", () => {
    // Arrange & Act
    const details: IAiErrorDetails = extractAiErrorDetails("raw string error");

    // Assert
    expect(details.message).toBe("raw string error");
    expect(details.providerMessage).toBeNull();
    expect(details.statusCode).toBeNull();
  });

  it("should handle an APICallError with no requestBodyValues.model", () => {
    // Arrange
    const error: APICallError = new APICallError({
      message: "Bad Request",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
    });

    // Act
    const details: IAiErrorDetails = extractAiErrorDetails(error);

    // Assert
    expect(details.model).toBeNull();
    expect(details.providerMessage).toBeNull();
    expect(details.provider).toBe("api.openai.com");
    expect(details.statusCode).toBe(400);
  });

  it("should handle an APICallError with rate limit status 429", () => {
    // Arrange
    const error: APICallError = new APICallError({
      message: "Rate limit exceeded",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: { model: "openai/gpt-4o" },
      statusCode: 429,
      isRetryable: true,
    });

    // Act
    const details: IAiErrorDetails = extractAiErrorDetails(error);

    // Assert
    expect(details.statusCode).toBe(429);
    expect(details.isRetryable).toBe(true);
    expect(details.model).toBe("openai/gpt-4o");
    expect(details.providerMessage).toBeNull();
  });

  it("should prefer metadata.raw as providerMessage when present", () => {
    // Arrange
    const error: APICallError = new APICallError({
      message: "Provider returned malformed response",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: { model: "openai/gpt-4o" },
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: "Provider internal validation failed",
          metadata: {
            raw: "openai/gpt-4o does not support parameter 'strict_json'",
          },
        },
      }),
      isRetryable: false,
    });

    // Act
    const details: IAiErrorDetails = extractAiErrorDetails(error);

    // Assert
    expect(details.providerMessage).toBe("openai/gpt-4o does not support parameter 'strict_json'");
  });
});

describe("formatAiErrorForLog", () => {
  it("should format a full APICallError into a readable log line", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "User not found.",
      providerMessage: "User not found.",
      provider: "openrouter.ai",
      model: "minimax/minimax-m2.5",
      statusCode: 401,
      responseBody: '{"error":{"message":"User not found."}}',
      isRetryable: false,
      url: "https://openrouter.ai/api/v1/chat/completions",
    };

    // Act
    const logLine: string = formatAiErrorForLog(details);

    // Assert
    expect(logLine).toContain("AI API error: User not found.");
    expect(logLine).toContain("provider: openrouter.ai");
    expect(logLine).toContain("model: minimax/minimax-m2.5");
    expect(logLine).toContain("status: 401");
    expect(logLine).toContain("retryable: false");
    expect(logLine).toContain("response:");
  });

  it("should format a plain error with only a message", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "something broke",
      providerMessage: null,
      provider: null,
      model: null,
      statusCode: null,
      responseBody: null,
      isRetryable: null,
      url: null,
    };

    // Act
    const logLine: string = formatAiErrorForLog(details);

    // Assert
    expect(logLine).toBe("AI API error: something broke");
  });
});

describe("formatAiErrorForUser", () => {
  it("should produce an auth failure message for 401", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "User not found.",
      providerMessage: "User not found.",
      provider: "openrouter.ai",
      model: "minimax/minimax-m2.5",
      statusCode: 401,
      responseBody: null,
      isRetryable: false,
      url: null,
    };

    // Act
    const userMsg: string = formatAiErrorForUser(details);

    // Assert
    expect(userMsg).toContain("Authentication failed");
    expect(userMsg).toContain("openrouter.ai");
    expect(userMsg).toContain("minimax/minimax-m2.5");
    expect(userMsg).toContain("User not found.");
  });

  it("should produce a rate limit message for 429", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "Rate limit exceeded",
      providerMessage: null,
      provider: "openrouter.ai",
      model: null,
      statusCode: 429,
      responseBody: null,
      isRetryable: true,
      url: null,
    };

    // Act
    const userMsg: string = formatAiErrorForUser(details);

    // Assert
    expect(userMsg).toContain("rate limit");
  });

  it("should produce a server error message for 500+", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "Internal Server Error",
      providerMessage: null,
      provider: "openrouter.ai",
      model: null,
      statusCode: 502,
      responseBody: null,
      isRetryable: null,
      url: null,
    };

    // Act
    const userMsg: string = formatAiErrorForUser(details);

    // Assert
    expect(userMsg).toContain("experiencing issues");
  });

  it("should produce a generic message for a plain Error", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "something went wrong",
      providerMessage: null,
      provider: null,
      model: null,
      statusCode: null,
      responseBody: null,
      isRetryable: null,
      url: null,
    };

    // Act
    const userMsg: string = formatAiErrorForUser(details);

    // Assert
    expect(userMsg).toContain("An error occurred: something went wrong");
  });

  it("should include HTTP status for non-standard error codes", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "Weird error",
      providerMessage: null,
      provider: null,
      model: null,
      statusCode: 418,
      responseBody: null,
      isRetryable: null,
      url: null,
    };

    // Act
    const userMsg: string = formatAiErrorForUser(details);

    // Assert
    expect(userMsg).toContain("HTTP 418");
  });

  it("should show provider metadata.raw details when available", () => {
    // Arrange
    const details: IAiErrorDetails = {
      message: "Provider returned malformed response",
      providerMessage: "openai/gpt-4o does not support parameter 'strict_json'",
      provider: "openrouter.ai",
      model: "openai/gpt-4o",
      statusCode: 400,
      responseBody: null,
      isRetryable: false,
      url: null,
    };

    // Act
    const userMsg: string = formatAiErrorForUser(details);

    // Assert
    expect(userMsg).toContain("openai/gpt-4o does not support parameter 'strict_json'");
    expect(userMsg).toContain("Provider: openrouter.ai");
    expect(userMsg).toContain("Model: openai/gpt-4o");
  });
});

//#endregion Tests
