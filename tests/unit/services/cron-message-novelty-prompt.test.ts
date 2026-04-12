import { describe, it, expect } from "vitest";

import { buildCronNoveltyPrompt } from "../../../src/services/cron-message-history.service.js";

describe("buildCronNoveltyPrompt", () => {
  it("includes precedence-based novelty rules", () => {
    const prompt: string = buildCronNoveltyPrompt({
      taskContextBlock: "Task context:\nname: test",
      candidateMessage: "Candidate alert",
      similarMessagesBlock: "#1\ncontent: previous alert",
    });

    expect(prompt).toContain("Decision precedence");
    expect(prompt).toContain("TASK MODE RULE");
    expect(prompt).toContain("EXPLICIT IDENTIFIER RULE");
    expect(prompt).toContain("CORE EVENT RULE");
  });

  it("embeds provided candidate and similar blocks verbatim", () => {
    const prompt: string = buildCronNoveltyPrompt({
      taskContextBlock: "Task context:\ncustom",
      candidateMessage: "⚠ ENERGY ALERT test message",
      similarMessagesBlock: "#1\ncontent: old message",
    });

    expect(prompt).toContain("Task context:\ncustom");
    expect(prompt).toContain("Candidate message:\n⚠ ENERGY ALERT test message");
    expect(prompt).toContain("#1\ncontent: old message");
  });

  it("does not include score/taskId/sentAt labels in similar messages block", () => {
    const similarMessagesBlock = `#1
content: previous alert`;

    const prompt: string = buildCronNoveltyPrompt({
      taskContextBlock: "Task context:\nname: test",
      candidateMessage: "Candidate alert",
      similarMessagesBlock,
    });

    expect(prompt).toContain("content: previous alert");
    expect(prompt).not.toContain("score:");
    expect(prompt).not.toContain("taskId:");
    expect(prompt).not.toContain("sentAt:");
  });

  it("includes precedence rules for periodic deliverables vs event alerts", () => {
    const prompt: string = buildCronNoveltyPrompt({
      taskContextBlock: "Task context:\nname: test",
      candidateMessage: "Daily digest: 5 items",
      similarMessagesBlock: "#1\ncontent: yesterday's summary",
    });

    expect(prompt).toContain("periodic deliverable");
    expect(prompt).toContain("event-alert");
  });

  it("uses text-only previous messages header", () => {
    const prompt: string = buildCronNoveltyPrompt({
      taskContextBlock: "Task context:\nname: test",
      candidateMessage: "Candidate alert",
      similarMessagesBlock: "#1\ncontent: previous alert",
    });

    expect(prompt).toContain("Previous sent messages (same task, text only):");
  });
});
