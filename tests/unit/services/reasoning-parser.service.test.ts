import { describe, expect, it } from "vitest";

import { ReasoningParserService } from "../../../src/services/providers/reasoning/reasoning-parser.service.js";

describe("ReasoningParserService", () => {
  it("extracts reasoning and cleaned answer from think tags", () => {
    const parsed = ReasoningParserService.parseThinkTags(
      "<think>First line\nSecond line</think>\nFinal answer text"
    );

    expect(parsed.reasoning).toBe("First line\nSecond line");
    expect(parsed.cleanedContent).toBe("Final answer text");
  });

  it("extracts reasoning and cleaned answer from thinking tags", () => {
    const parsed = ReasoningParserService.parseThinkTags(
      "<thinking>Reasoning line\nSecond reasoning line</thinking>\nFinal answer text"
    );

    expect(parsed.reasoning).toBe("Reasoning line\nSecond reasoning line");
    expect(parsed.cleanedContent).toBe("Final answer text");
  });

  it("extracts answer from explicit Final Answer marker", () => {
    const extracted = ReasoningParserService.extractAnswerFromReasoning(
      "Thinking...\n\n**Final Answer**\nThe final value is 42."
    );

    expect(extracted.answer).toBe("The final value is 42.");
    expect(extracted.method).toBe("answer_section");
  });

  it("extracts reasoning from reasoning_content and reasoning_details", () => {
    const reasoning = ReasoningParserService.extractReasoningFromAdditionalKwargs({
      reasoning_content: "Top-level reasoning",
      reasoning_details: [{ text: "Detail A" }, { summary: [{ text: "Detail B" }] }],
    });

    expect(reasoning).toContain("Top-level reasoning");
    expect(reasoning).toContain("Detail A");
    expect(reasoning).toContain("Detail B");
  });

  it("parses JSON tool call envelope from <tool_call>", () => {
    const parsed = ReasoningParserService.parseToolCallsFromText(
      '<tool_call>{"name":"get_cron","arguments":{"taskId":"abc"}}</tool_call>',
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("get_cron");
    expect(parsed[0].arguments).toBe('{"taskId":"abc"}');
  });

  it("parses alias envelope from <toolcall>", () => {
    const parsed = ReasoningParserService.parseToolCallsFromText(
      '<toolcall>{"name":"remove_cron","arguments":{"taskId":"abc"}}</toolcall>',
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("remove_cron");
    expect(parsed[0].arguments).toBe('{"taskId":"abc"}');
  });

  it("parses qwen function envelope from <tool_call>", () => {
    const parsed = ReasoningParserService.parseToolCallsFromText(
      '<tool_call><function=get_cron>{"taskId":"abc"}</function></tool_call>',
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("get_cron");
    expect(parsed[0].arguments).toBe('{"taskId":"abc"}');
  });

  it("coerces python-style literals in qwen parameter envelopes", () => {
    const parsed = ReasoningParserService.parseToolCallsFromText(
      "<tool_call><function=add_cron><parameter=notifyUser>True</parameter><parameter=maxRetries>3</parameter><parameter=notes>Hello</parameter><parameter=fallback>None</parameter><parameter=enabled>False</parameter></function></tool_call>",
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("add_cron");
    expect(JSON.parse(parsed[0].arguments)).toEqual({
      notifyUser: true,
      maxRetries: 3,
      notes: "Hello",
      fallback: null,
      enabled: false,
    });
  });

  it("normalizes object arguments to JSON string", () => {
    const normalized = ReasoningParserService.normalizeToolArguments({ taskId: "abc" });

    expect(normalized).toBe('{"taskId":"abc"}');
  });

  it("returns empty list for malformed tool-call envelopes", () => {
    const parsed = ReasoningParserService.parseToolCallsFromText(
      '<tool_call><function=get_cron>{bad json}</function></tool_call>',
    );

    expect(parsed).toHaveLength(0);
  });
});
