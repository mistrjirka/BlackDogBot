import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import {
  getDuplicateToolCallLoopInfo,
} from "../../../src/utils/prepare-step.js";

//#region Helpers

function _assistantToolCallMessage(
  toolName: string,
  args: Record<string, unknown> = {},
  useInputField: boolean = false,
): ModelMessage {
  const toolCallPart: Record<string, unknown> = {
    type: "tool-call",
    toolName,
    toolCallId: `call_${toolName}`,
  };

  if (useInputField) {
    toolCallPart.input = args;
  } else {
    toolCallPart.args = args;
  }

  return {
    role: "assistant",
    content: [toolCallPart],
  } as unknown as ModelMessage;
}

function _assistantTextMessage(text: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }] as unknown as ModelMessage["content"],
  } as unknown as ModelMessage;
}

//#endregion Helpers

describe("prepare-step duplicate tool-call detection", () => {
  it("should not detect duplicate loop before threshold of 3 identical steps", () => {
    const messages: ModelMessage[] = [
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1, title: "A" }],
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1, title: "A" }],
      }),
    ];

    expect(getDuplicateToolCallLoopInfo(1, messages).isLoopDetected).toBe(false);
  });

  it("should detect duplicate loop after 3 consecutive identical tool-call steps", () => {
    const messages: ModelMessage[] = [
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1, title: "A" }],
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1, title: "A" }],
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1, title: "A" }],
      }),
    ];

    expect(getDuplicateToolCallLoopInfo(2, messages).isLoopDetected).toBe(true);
  });

  it("should not detect duplicate loop when nested args differ", () => {
    const messages: ModelMessage[] = [
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1, title: "A" }],
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 2, title: "B" }],
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 3, title: "C" }],
      }),
    ];

    expect(getDuplicateToolCallLoopInfo(2, messages).isLoopDetected).toBe(false);
  });

  it("should detect duplicate loop when nested args are semantically identical with different key order", () => {
    const messages: ModelMessage[] = [
      _assistantToolCallMessage("write_table_items", {
        tableName: "items",
        data: [{ title: "A", id: 1 }],
        databaseName: "db",
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1, title: "A" }],
      }),
      _assistantToolCallMessage("write_table_items", {
        data: [{ title: "A", id: 1 }],
        databaseName: "db",
        tableName: "items",
      }),
    ];

    expect(getDuplicateToolCallLoopInfo(2, messages).isLoopDetected).toBe(true);
  });

  it("should not detect duplicate loop when assistant messages are not consecutive", () => {
    const messages: ModelMessage[] = [
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1 }],
      }),
      _assistantTextMessage("I will do something else now."),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1 }],
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1 }],
      }),
    ];

    expect(getDuplicateToolCallLoopInfo(3, messages).isLoopDetected).toBe(false);
  });

  it("should not detect duplicate loop if most recent assistant step is think", () => {
    const messages: ModelMessage[] = [
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1 }],
      }),
      _assistantToolCallMessage("write_table_items", {
        databaseName: "db",
        tableName: "items",
        data: [{ id: 1 }],
      }),
      _assistantToolCallMessage("think", { thought: "Break loop" }),
    ];

    expect(getDuplicateToolCallLoopInfo(2, messages).isLoopDetected).toBe(false);
  });

  it("should return loop info with signature and duplicate summary", () => {
    const messages: ModelMessage[] = [
      _assistantToolCallMessage("edit_interval", {
        taskId: "t-1",
        schedule: { type: "cron", expression: "0 * * * *" },
      }),
      _assistantToolCallMessage("edit_interval", {
        schedule: { expression: "0 * * * *", type: "cron" },
        taskId: "t-1",
      }),
      _assistantToolCallMessage("edit_interval", {
        taskId: "t-1",
        schedule: { type: "cron", expression: "0 * * * *" },
      }),
    ];

    const loopInfo = getDuplicateToolCallLoopInfo(2, messages);

    expect(loopInfo.isLoopDetected).toBe(true);
    expect(loopInfo.canonicalSignature.length).toBeGreaterThan(0);
    expect(loopInfo.duplicateCount).toBe(3);
    expect(loopInfo.summaryString).toContain("3x(");
    expect(loopInfo.summaryString).toContain("edit_interval");
  });
});
