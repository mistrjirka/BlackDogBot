import { describe, it, expect } from "vitest";

import { buildCronNoveltyPrompt } from "../../../src/services/cron-message-history.service.js";

describe("buildCronNoveltyPrompt", () => {
  it("includes same-event dedup rules and examples", () => {
    const prompt: string = buildCronNoveltyPrompt({
      taskContextBlock: "Task context:\nname: test",
      candidateMessage: "Candidate alert",
      similarMessagesBlock: "#1\ncontent: previous alert",
    });

    expect(prompt).toContain("SAME CORE EVENT");
    expect(prompt).toContain("Added details about an already-known event are NOT new information");
    expect(prompt).toContain("CORE EVENT TEST (must be applied first)");
    expect(prompt).toContain("EXAMPLE B (duplicate -> false)");
    expect(prompt).toContain("Czech factory arson verified; IEA says crisis worse than 1970s");
    expect(prompt).toContain("If core event already exists, isNewInformation MUST be false");
  });

  it("embeds provided candidate and similar blocks verbatim", () => {
    const prompt: string = buildCronNoveltyPrompt({
      taskContextBlock: "Task context:\ncustom",
      candidateMessage: "⚠ ENERGY ALERT test message",
      similarMessagesBlock: "#1\nscore: 0.9\ncontent: old message",
    });

    expect(prompt).toContain("Task context:\ncustom");
    expect(prompt).toContain("Candidate message:\n⚠ ENERGY ALERT test message");
    expect(prompt).toContain("#1\nscore: 0.9\ncontent: old message");
  });
});
