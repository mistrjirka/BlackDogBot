import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { invokeAgentAsync } from "../../../src/agent/langchain-agent.js";

function createAgenticStubAgent(messages: Array<HumanMessage | AIMessage | ToolMessage>): {
  invoke: (input: unknown, options: unknown) => Promise<{ messages: Array<HumanMessage | AIMessage | ToolMessage> }>;
} {
  return {
    invoke: async (_input: unknown, _options: unknown) => ({ messages }),
  };
}

describe("Tool Call Agentic Multi-Turn XML Fallback", () => {
  it("handles 3-turn agentic flow with XML tool-call fallback on middle turn", async () => {
    const messages: Array<HumanMessage | AIMessage | ToolMessage> = [
      new HumanMessage({ content: "Turn 1: list current crons" }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "list_crons",
            args: {},
            id: "call-list-1",
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({ content: "[]", tool_call_id: "call-list-1", name: "list_crons" }),

      new HumanMessage({ content: "Turn 2: fetch cron task-123" }),
      new AIMessage({
        content: "",
        additional_kwargs: {
          reasoning_content:
            "<tool_call><function=get_cron>{\"taskId\":\"task-123\"}</function></tool_call>",
        },
      }),
      new ToolMessage({
        content: '{"taskId":"task-123","name":"nightly"}',
        tool_call_id: "text-tool-call-1",
        name: "get_cron",
      }),

      new HumanMessage({ content: "Turn 3: summarize" }),
      new AIMessage({ content: "Summary: cron task-123 is nightly." }),
    ];

    const agent = createAgenticStubAgent(messages);
    const result = await invokeAgentAsync(
      agent as unknown as ReturnType<typeof createAgenticStubAgent>,
      "start",
      "thread-agentic-multi-turn",
    );

    expect(result.stepsCount).toBeGreaterThanOrEqual(2);
    expect(result.text.toLowerCase()).toContain("summary");
    expect(result.text).not.toContain("<tool_call>");
  });

  it("handles 4-turn flow with mixed content-array XML and reasoning-content alias envelopes", async () => {
    const messages: Array<HumanMessage | AIMessage | ToolMessage> = [
      new HumanMessage({ content: "Turn 1: list current crons" }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "list_crons",
            args: {},
            id: "call-list-2",
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({ content: "[]", tool_call_id: "call-list-2", name: "list_crons" }),

      new HumanMessage({ content: "Turn 2: fetch cron task-123" }),
      new AIMessage({
        content: [
          { type: "text", text: "<think>Need to fetch details first.</think>" },
          {
            type: "text",
            text: '<tool_call><function=get_cron>{"taskId":"task-123"}</function></tool_call>',
          },
        ],
      }),
      new ToolMessage({
        content: '{"taskId":"task-123","name":"nightly","enabled":true}',
        tool_call_id: "text-tool-call-1",
        name: "get_cron",
      }),

      new HumanMessage({ content: "Turn 3: disable cron task-123" }),
      new AIMessage({
        content: "",
        additional_kwargs: {
          reasoning_content:
            '<toolcall>{"name":"edit_cron","arguments":{"taskId":"task-123","patch":{"enabled":false}}}</toolcall>',
        },
      }),
      new ToolMessage({
        content: '{"success":true,"task":{"taskId":"task-123","enabled":false}}',
        tool_call_id: "text-tool-call-1",
        name: "edit_cron",
      }),

      new HumanMessage({ content: "Turn 4: summarize final state" }),
      new AIMessage({ content: "Summary: task-123 is now disabled." }),
    ];

    const agent = createAgenticStubAgent(messages);
    const result = await invokeAgentAsync(
      agent as unknown as ReturnType<typeof createAgenticStubAgent>,
      "start",
      "thread-agentic-multi-turn-mixed",
    );

    expect(result.stepsCount).toBeGreaterThanOrEqual(3);
    expect(result.text.toLowerCase()).toContain("disabled");
    expect(result.text).not.toContain("<tool_call>");
    expect(result.text).not.toContain("<toolcall>");
  });
});
