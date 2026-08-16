import { describe, expect, it, vi } from "vitest";
import type { LanguageModel, Tool, ToolSet } from "ai";

const state = vi.hoisted(() => ({
  workerTools: undefined as ToolSet | undefined,
  generateOptions: undefined as
    | { prompt: string; abortSignal?: AbortSignal }
    | undefined,
  failWorker: false,
}));

vi.mock("ai", async () => {
  class FakeToolLoopAgent {
    public constructor(options: { tools: ToolSet }) {
      if (state.failWorker) throw new Error("worker tools unavailable");
      state.workerTools = options.tools;
    }

    public async generate(options: {
      prompt: string;
      abortSignal?: AbortSignal;
    }): Promise<{ text: string }> {
      state.generateOptions = options;
      return { text: "worker result" };
    }
  }

  return {
    tool: (definition: unknown): unknown => definition,
    ToolLoopAgent: FakeToolLoopAgent,
    stepCountIs: (): unknown => ({}),
  };
});

import { createDelegateAgentTool } from "../../src/agent/delegate-agent.js";

describe("delegate agent tool", () => {
  it("removes recursive delegation and forwards the abort signal", async () => {
    const abortController = new AbortController();
    const delegateTool = createDelegateAgentTool({
      model: {} as LanguageModel,
      tools: {
        think: {} as Tool,
        delegate_agent: {} as Tool,
      },
    });

    const result = await delegateTool.execute?.(
      { task: "do the work" },
      {
        abortSignal: abortController.signal,
        toolCallId: "call-1",
        messages: [],
      },
    );

    expect(result).toEqual({
      success: true,
      output: "worker result",
      error: null,
    });
    expect(state.workerTools).toEqual({ think: expect.anything() });
    expect(state.workerTools).not.toHaveProperty("delegate_agent");
    expect(state.generateOptions?.prompt).toBe("do the work");
    expect(state.generateOptions?.abortSignal).toBe(abortController.signal);
  });

  it("returns worker failures as structured tool errors", async () => {
    const delegateTool = createDelegateAgentTool({
      model: {} as LanguageModel,
      tools: {
        think: {} as Tool,
      },
    });

    state.failWorker = true;
    const result = await delegateTool.execute?.(
      { task: "do the work" },
      { toolCallId: "call-2", messages: [] },
    );

    expect(result).toEqual({
      success: false,
      output: "",
      error: "worker tools unavailable",
    });
  });
});
