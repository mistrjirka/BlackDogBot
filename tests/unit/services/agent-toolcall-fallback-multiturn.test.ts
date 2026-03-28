import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { invokeAgentAsync } from "../../../src/agent/langchain-agent.js";

function createStubAgent(messages: Array<HumanMessage | AIMessage | ToolMessage>): {
  invoke: (input: unknown, options: unknown) => Promise<{ messages: Array<HumanMessage | AIMessage | ToolMessage> }>;
} {
  return {
    invoke: async (_input: unknown, _options: unknown) => ({ messages }),
  };
}

describe("invokeAgentAsync textual tool-call fallback in agentic multi-turn mode", () => {
  it("counts textual tool call from third turn when structured tool_calls are missing", async () => {
    const messages: Array<HumanMessage | AIMessage | ToolMessage> = [
      new HumanMessage({ content: "Turn 1: schedule something" }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "list_crons",
            args: {},
            id: "call-1",
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({ content: "[]", tool_call_id: "call-1", name: "list_crons" }),
      new HumanMessage({ content: "Turn 2: now fetch one cron by id" }),
      new AIMessage({
        content: "",
        additional_kwargs: {
          reasoning_content: "<tool_call><function=get_cron>{\"taskId\":\"task-123\"}</function></tool_call>",
        },
      }),
      new ToolMessage({ content: '{"taskId":"task-123","name":"demo"}', tool_call_id: "text-tool-call-1", name: "get_cron" }),
      new HumanMessage({ content: "Turn 3: finalize" }),
      new AIMessage({ content: "Done. Retrieved cron task-123." }),
    ];

    const agent = createStubAgent(messages);
    const result = await invokeAgentAsync(
      agent as unknown as ReturnType<typeof createStubAgent>,
      "start",
      "thread-multi-turn",
    );

    expect(result.stepsCount).toBeGreaterThanOrEqual(2);
    expect(result.text).toContain("Done.");
  });
});
