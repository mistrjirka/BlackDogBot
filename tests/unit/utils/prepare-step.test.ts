import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { FORCE_THINK_INTERVAL } from "../../../src/shared/constants.js";
import { isReasoningRequired } from "../../../src/utils/prepare-step.js";

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

function _repeatNonReasoningSteps(count: number): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (let i: number = 0; i < count; i++) {
    result.push(_assistantToolCallMessage("run_cmd", { command: `echo ${i}` }));
  }

  return result;
}

//#endregion Helpers

describe("prepare-step reasoning requirement", () => {
  it("should be optional before the interval is reached", () => {
    const messages: ModelMessage[] = _repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1);

    expect(isReasoningRequired(messages)).toBe(false);
  });

  it("should require reasoning at the interval when no think/reasoning was provided", () => {
    const messages: ModelMessage[] = _repeatNonReasoningSteps(FORCE_THINK_INTERVAL);

    expect(isReasoningRequired(messages)).toBe(true);
  });

  it("should reset requirement when think was used", () => {
    const messages: ModelMessage[] = [
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
      _assistantToolCallMessage("think", { thought: "I should plan first." }),
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
    ];

    expect(isReasoningRequired(messages)).toBe(false);
  });

  it("should reset requirement when non-think tool includes non-empty reasoning", () => {
    const messages: ModelMessage[] = [
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
      _assistantToolCallMessage("searxng", {
        query: "news",
        reasoning: "I need current sources before concluding.",
      }),
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
    ];

    expect(isReasoningRequired(messages)).toBe(false);
  });

  it("should treat blank reasoning as missing", () => {
    const messages: ModelMessage[] = [
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
      _assistantToolCallMessage("searxng", {
        query: "news",
        reasoning: "   ",
      }),
    ];

    expect(isReasoningRequired(messages)).toBe(true);
  });

  it("should read reasoning from input field as well as args", () => {
    const messages: ModelMessage[] = [
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
      _assistantToolCallMessage(
        "searxng",
        {
          query: "news",
          reasoning: "Input field reasoning works too.",
        },
        true,
      ),
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
    ];

    expect(isReasoningRequired(messages)).toBe(false);
  });

  it("should ignore done steps for requirement satisfaction", () => {
    const messages: ModelMessage[] = [
      ..._repeatNonReasoningSteps(FORCE_THINK_INTERVAL - 1),
      _assistantToolCallMessage("done", { summary: "finished" }),
      _assistantToolCallMessage("run_cmd", { command: "echo after-done" }),
    ];

    expect(isReasoningRequired(messages)).toBe(true);
  });
});
