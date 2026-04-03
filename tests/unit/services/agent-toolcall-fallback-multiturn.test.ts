import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { invokeAgentAsync } from "../../../src/agent/langchain-agent.js";

function createStubAgent(messages: Array<HumanMessage | AIMessage | ToolMessage>): {
  invoke: (input: unknown, options: unknown) => Promise<{ messages: Array<HumanMessage | AIMessage | ToolMessage> }>;
  stream: (input: unknown, options: unknown) => Promise<AsyncGenerator<["tools" | "updates", Record<string, unknown>]>>;
  getState: (config: unknown) => Promise<{ values: { messages: Array<HumanMessage | AIMessage | ToolMessage> } }>;
} {
  function extractReasoningContent(aiMsg: AIMessage): string | undefined {
    return aiMsg.additional_kwargs?.reasoning_content as string | undefined;
  }

  function parseTextualToolCalls(reasoningContent: string): Array<{ name: string; args: Record<string, unknown>; id: string }> {
    const toolCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];
    const regex = /<tool_call><function=(\w+)>([^<]+)<\/function><\/tool_call>/g;
    let match;
    while ((match = regex.exec(reasoningContent)) !== null) {
      const name = match[1];
      const argsStr = match[2];
      try {
        const args = JSON.parse(argsStr) as Record<string, unknown>;
        toolCalls.push({ name, args, id: `text-${toolCalls.length}` });
      } catch {
        // ignore parse errors
      }
    }
    return toolCalls;
  }

  async function* generateToolEvents(): AsyncGenerator<["tools" | "updates", Record<string, unknown>]> {
    for (const msg of messages) {
      if (msg._getType() === "ai") {
        const aiMsg = msg as AIMessage;
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          for (const tc of aiMsg.tool_calls) {
            yield ["tools", {
              event: "on_tool_start",
              name: tc.name,
              input: tc.args,
              toolCallId: tc.id,
            }];
          }
        }
        const reasoningContent = extractReasoningContent(aiMsg);
        if (reasoningContent) {
          const textualToolCalls = parseTextualToolCalls(reasoningContent);
          for (const tc of textualToolCalls) {
            yield ["tools", {
              event: "on_tool_start",
              name: tc.name,
              input: tc.args,
              toolCallId: tc.id,
            }];
          }
        }
      }
    }
  }

  return {
    invoke: async (_input: unknown, _options: unknown) => ({ messages }),
    stream: async (_input: unknown, _options: unknown) => generateToolEvents(),
    getState: async (_config: unknown) => ({ values: { messages } }),
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

    const agent = createStubAgent(messages) as any;
    const result = await invokeAgentAsync(
      agent,
      "start",
      "thread-multi-turn",
    );

    expect(result.stepsCount).toBeGreaterThanOrEqual(2);
    expect(result.text).toContain("Done.");
  });

  it("reuses tool input from on_tool_start when on_tool_end input is missing", async () => {
    const streamEvents: Array<["tools" | "updates", Record<string, unknown>]> = [
      ["tools", {
        event: "on_tool_start",
        name: "create_table",
        input: { databaseName: "db", tableName: "items" },
        toolCallId: "tc-1",
      }],
      ["tools", {
        event: "on_tool_end",
        name: "create_table",
        toolCallId: "tc-1",
        output: { success: true },
      }],
    ];

    async function* generateToolEvents(): AsyncGenerator<["tools" | "updates", Record<string, unknown>]> {
      for (const event of streamEvents) {
        yield event;
      }
    }

    const onToolEndAsync = vi.fn(async (_toolName: string, toolInput: unknown): Promise<boolean> => {
      const input = toolInput as Record<string, unknown>;
      expect(input.tableName).toBe("items");
      return false;
    });

    const agent = {
      stream: async () => generateToolEvents(),
      getState: async () => ({ values: { messages: [new AIMessage({ content: "done" })] } }),
    } as any;

    const result = await invokeAgentAsync(
      agent,
      "start",
      "thread-tool-input-resolution",
      undefined,
      undefined,
      onToolEndAsync,
    );

    expect(result.text).toBe("done");
    expect(onToolEndAsync).toHaveBeenCalledTimes(1);
  });
});
