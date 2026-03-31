import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { createChatModel } from "../../../src/services/langchain-model.service.js";
import type { IAiConfig } from "../../../src/shared/types/config.types.js";

describe("createChatModel profile request behavior", () => {
  it("injects reasoning_format, parallel_tool_calls, and chat_template_kwargs from active profile", () => {
    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
        activeProfile: "qwen3_5",
      },
    };

    const model = createChatModel(config);
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.reasoning_format).toBe("none");
    expect(modelKwargs.parallel_tool_calls).toBe(true);
    expect(modelKwargs.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("can disable thinking in chat_template_kwargs while keeping same model/profile", () => {
    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
        activeProfile: "qwen3_5",
      },
    };

    const model = createChatModel(config, { disableThinking: true });
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.reasoning_format).toBe("none");
    expect(modelKwargs.parallel_tool_calls).toBe(true);
    expect(modelKwargs.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});

describe("createChatModel parallel tool calls from capability service", () => {
  beforeEach(() => {
    (AiCapabilityService as unknown as { _instance: unknown })._instance = null;
  });

  afterEach(() => {
    (AiCapabilityService as unknown as { _instance: unknown })._instance = null;
  });

  it("injects parallel_tool_calls when capability service says supported", () => {
    const capabilityService = AiCapabilityService.getInstance();
    capabilityService.initialize({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    });
    capabilityService.setSupportsParallelToolCalls(true);

    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    };

    const model = createChatModel(config);
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.parallel_tool_calls).toBe(true);
  });

  it("does not inject parallel_tool_calls when capability service says unsupported", () => {
    const capabilityService = AiCapabilityService.getInstance();
    capabilityService.initialize({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    });
    capabilityService.setSupportsParallelToolCalls(false);

    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    };

    const model = createChatModel(config);
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.parallel_tool_calls).toBe(undefined);
  });

  it("profile parallel_tool_calls takes precedence over capability service", () => {
    const capabilityService = AiCapabilityService.getInstance();
    capabilityService.initialize({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    });
    capabilityService.setSupportsParallelToolCalls(false);

    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
        activeProfile: "qwen3_5",
      },
    };

    const model = createChatModel(config);
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.parallel_tool_calls).toBe(true);
  });
});
