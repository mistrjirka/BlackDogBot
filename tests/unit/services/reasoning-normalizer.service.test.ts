import { describe, expect, it } from "vitest";

import { ReasoningNormalizerService } from "../../../src/services/providers/reasoning/reasoning-normalizer.service.js";

describe("ReasoningNormalizerService", () => {
  it("uses content directly when reasoning is empty", () => {
    const normalized = ReasoningNormalizerService.normalize({
      content: "Hello final answer",
      reasoningContent: "",
    });

    expect(normalized.text).toBe("Hello final answer");
    expect(normalized.method).toBe("content_only");
  });

  it("renders reasoning blockquote and extracted answer when content is empty", () => {
    const normalized = ReasoningNormalizerService.normalize({
      content: "",
      reasoningContent: "**Final Answer**\nUse tool X then Y",
    });

    expect(normalized.text).toContain("> **Final Answer**");
    expect(normalized.text).toContain("Use tool X then Y");
    expect(normalized.answer).toBe("Use tool X then Y");
  });
});
