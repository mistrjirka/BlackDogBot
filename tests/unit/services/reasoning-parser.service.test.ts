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
});
