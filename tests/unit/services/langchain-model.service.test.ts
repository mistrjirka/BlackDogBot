import { describe, expect, it } from "vitest";

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
