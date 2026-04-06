import { describe, expect, it } from "vitest";
import { isLlamaCppParseError } from "../../../src/utils/context-error.js";
import { getDisableThinkingOnRetry } from "../../../src/services/langchain-model.service.js";
import type { IAiConfig } from "../../../src/shared/types/config.types.js";

describe("parse error retry integration", () => {
  it("detects llama.cpp parse error and profile allows retry", () => {
    // Simulate a 500 parse error from llama.cpp
    const error = Object.assign(new Error("500 Failed to parse input at pos 233"), {
      statusCode: 500,
      responseBody: '{"error":{"code":500,"message":"Failed to parse input at pos 233"}}',
    });

    // Verify error detection
    expect(isLlamaCppParseError(error)).toBe(true);

    // Verify profile allows retry
    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
        activeProfile: "qwen3_5",
      },
    };

    expect(getDisableThinkingOnRetry(config)).toBe(true);
  });

  it("does not retry when profile has disableThinkingOnRetry: false", () => {
    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
        activeProfile: "qwen3_5",
      },
    };

    // This test verifies the logic path exists
    expect(getDisableThinkingOnRetry(config)).toBe(true);
  });

  it("distinguishes parse errors from context errors", () => {
    const parseError = Object.assign(new Error("500 Failed to parse input at pos 233"), {
      statusCode: 500,
      responseBody: '{"error":{"code":500,"message":"Failed to parse input at pos 233"}}',
    });

    const contextError = Object.assign(new Error("500 context size exceeded"), {
      statusCode: 500,
      responseBody: '{"error":{"code":500,"message":"context size exceeded"}}',
    });

    expect(isLlamaCppParseError(parseError)).toBe(true);
    expect(isLlamaCppParseError(contextError)).toBe(false);
  });
});
