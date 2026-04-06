import { describe, expect, it } from "vitest";

import {
  buildCronDispatchPolicyPrompt,
  parseSearchMetadata,
  buildSearchPreview,
} from "../../../src/services/cron-message-history-helpers.js";

describe("cron-message-history-helpers", () => {
  describe("buildCronDispatchPolicyPrompt", () => {
    it("includes task context and candidate message", () => {
      const result: string = buildCronDispatchPolicyPrompt({
        taskInstructions: "Send only alerts.",
        taskName: "TestTask",
        taskDescription: "A test task",
        candidateMessage: "Task completed successfully",
      });

      expect(result).toContain("Send only alerts.");
      expect(result).toContain("TestTask");
      expect(result).toContain("A test task");
      expect(result).toContain("Task completed successfully");
    });

    it("handles missing optional fields with defaults", () => {
      const result: string = buildCronDispatchPolicyPrompt({
        taskInstructions: "Run silently.",
        candidateMessage: "Done",
      });

      expect(result).toContain("taskName: unknown");
      expect(result).toContain("Run silently.");
      expect(result).toContain("Done");
    });

    it("returns a properly formatted prompt string", () => {
      const result: string = buildCronDispatchPolicyPrompt({
        taskInstructions: "Only critical alerts.",
        candidateMessage: "CRITICAL: System overload",
      });

      expect(result.length).toBeGreaterThan(100);
      expect(result).toContain("You are a strict cron notification policy checker");
    });
  });

  describe("parseSearchMetadata", () => {
    it("parses valid JSON metadata", () => {
      const rawMetadata: string = '{"taskId":"abc123","sentAt":"2024-01-01T00:00:00Z"}';
      const result = parseSearchMetadata(rawMetadata);

      expect(result.taskId).toBe("abc123");
      expect(result.sentAt).toBe("2024-01-01T00:00:00Z");
    });

    it("returns empty object for invalid JSON", () => {
      const rawMetadata: string = "not valid json {{{";
      const result = parseSearchMetadata(rawMetadata);

      expect(result).toEqual({});
    });

    it("returns empty object for empty string", () => {
      const result = parseSearchMetadata("");
      expect(result).toEqual({});
    });

    it("returns null for JSON null input", () => {
      const result = parseSearchMetadata("null");
      expect(result).toBeNull();
    });
  });

  describe("buildSearchPreview", () => {
    it("keeps short text unchanged", () => {
      const shortText: string = "Short content";
      const result: string = buildSearchPreview(shortText, 50);

      expect(result).toBe("Short content");
      expect(result.length).toBeLessThanOrEqual(50);
    });

    it("trims whitespace", () => {
      const textWithWhitespace: string = "  Multiple   spaces   here  ";
      const result: string = buildSearchPreview(textWithWhitespace, 50);

      expect(result).toBe("Multiple spaces here");
    });

    it("truncates long text with ellipsis", () => {
      const longText: string = "This is a very long piece of text that needs to be truncated because it exceeds the preview length limit";
      const previewLength: number = 30;
      const result: string = buildSearchPreview(longText, previewLength);

      expect(result.length).toBe(previewLength + 3); // 3 for "..."
      expect(result.endsWith("...")).toBe(true);
    });

    it("handles text exactly at preview length", () => {
      const exactText: string = "Exactly fifty chars!----------------------"; // 50 chars
      const result: string = buildSearchPreview(exactText, 50);

      expect(result).toBe(exactText);
    });

    it("normalizes multiple whitespaces to single space", () => {
      const multiSpace: string = "Word1\n\nWord2\t\tWord3";
      const result: string = buildSearchPreview(multiSpace, 100);

      expect(result).toBe("Word1 Word2 Word3");
    });
  });
});
