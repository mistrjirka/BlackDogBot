import { describe, expect, it } from "vitest";
import { tool, type ModelMessage, type ToolCallOptions, type ToolSet } from "ai";
import { z } from "zod";

import { FORCE_THINK_INTERVAL } from "../../../src/shared/constants.js";
import { wrapToolSetWithReasoning } from "../../../src/utils/tool-reasoning-wrapper.js";

//#region Helpers

function _assistantToolCallMessage(
  toolName: string,
  args: Record<string, unknown> = {},
): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolName,
        toolCallId: `call_${toolName}`,
        args,
      },
    ],
  } as unknown as ModelMessage;
}

function _messagesAtReasoningThreshold(): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (let i: number = 0; i < FORCE_THINK_INTERVAL; i++) {
    messages.push(_assistantToolCallMessage("run_cmd", { command: `echo ${i}` }));
  }

  return messages;
}

function _buildOptions(messages: ModelMessage[]): ToolCallOptions {
  return {
    toolCallId: "test-call-id",
    messages,
  };
}

//#endregion Helpers

describe("tool-reasoning-wrapper", () => {
  it("should add optional reasoning to non-think/non-done tool schemas", () => {
    const tools: ToolSet = {
      run_cmd: tool({
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }: { command: string }): Promise<{ ok: boolean }> => ({ ok: command.length > 0 }),
      }),
    };

    const wrapped: ToolSet = wrapToolSetWithReasoning(tools);
    const wrappedSchema = wrapped.run_cmd.inputSchema as z.ZodTypeAny;

    const parsed = wrappedSchema.safeParse({ command: "pwd", reasoning: "Need environment info first." });

    expect(parsed.success).toBe(true);
  });

  it("should reject non-exempt tools without reasoning when threshold is reached", async () => {
    const tools: ToolSet = {
      run_cmd: tool({
        inputSchema: z.object({ command: z.string() }),
        execute: async (): Promise<{ ok: boolean }> => ({ ok: true }),
      }),
    };

    const wrapped: ToolSet = wrapToolSetWithReasoning(tools);
    const execute = wrapped.run_cmd.execute!;

    expect(() => execute(
      { command: "pwd" },
      _buildOptions(_messagesAtReasoningThreshold()),
    )).toThrow(/requires non-empty reasoning/i);
  });

  it("should allow non-exempt tools with reasoning when threshold is reached", async () => {
    const tools: ToolSet = {
      run_cmd: tool({
        inputSchema: z.object({ command: z.string() }),
        execute: async (): Promise<{ ok: boolean }> => ({ ok: true }),
      }),
    };

    const wrapped: ToolSet = wrapToolSetWithReasoning(tools);
    const execute = wrapped.run_cmd.execute!;

    const result = await Promise.resolve(execute(
      { command: "pwd", reasoning: "I need to inspect working directory." },
      _buildOptions(_messagesAtReasoningThreshold()),
    ));

    expect(result).toEqual({ ok: true });
  });

  it("should strip reasoning before delegating to underlying tool", async () => {
    let receivedInput: Record<string, unknown> | null = null;

    const tools: ToolSet = {
      run_cmd: tool({
        inputSchema: z.object({ command: z.string() }),
        execute: async (input: { command: string }): Promise<{ ok: boolean }> => {
          receivedInput = input as unknown as Record<string, unknown>;
          return { ok: true };
        },
      }),
    };

    const wrapped: ToolSet = wrapToolSetWithReasoning(tools);
    const execute = wrapped.run_cmd.execute!;

    await Promise.resolve(execute(
      { command: "pwd", reasoning: "diagnostic" },
      _buildOptions([]),
    ));

    expect(receivedInput).toEqual({ command: "pwd" });
    expect(receivedInput).not.toHaveProperty("reasoning");
  });

  it("should keep done exempt from reasoning enforcement", async () => {
    const tools: ToolSet = {
      done: tool({
        inputSchema: z.object({ summary: z.string() }),
        execute: async ({ summary }: { summary: string }): Promise<{ summary: string }> => ({ summary }),
      }),
    };

    const wrapped: ToolSet = wrapToolSetWithReasoning(tools);
    const execute = wrapped.done.execute!;

    const result = await Promise.resolve(execute(
      { summary: "Complete." },
      _buildOptions(_messagesAtReasoningThreshold()),
    ));

    expect(result).toEqual({ summary: "Complete." });
  });
});
