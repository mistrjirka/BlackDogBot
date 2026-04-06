import { describe, expect, it } from "vitest";

import {
  formatToolCallForTelegram,
  formatStepTraceLines,
  buildCancelResponseText,
  escapeTelegramHtml,
  detectThinkLeakInModelText,
} from "../../../../src/platforms/telegram/telegram-formatters.js";
import type { IToolCallSummary } from "../../../../src/agent/types.js";

describe("telegram-formatters", () => {
  describe("formatToolCallForTelegram", () => {
    it("formats run_cmd command with known key", () => {
      const input: Record<string, unknown> = { command: "ls -la", reasoning: undefined };
      const result: string = formatToolCallForTelegram("run_cmd", input);
      expect(result).toBe("run_cmd(ls -la)");
    });

    it("truncates values longer than 60 characters", () => {
      const longCommand: string = "this is a very long command that exceeds the sixty character limit for display";
      const input: Record<string, unknown> = { command: longCommand };
      const result: string = formatToolCallForTelegram("run_cmd", input);
      expect(result.length).toBeLessThan(longCommand.length + 20);
      expect(result).toContain("...");
      expect(result.startsWith("run_cmd(")).toBe(true);
    });

    it("appends reasoning suffix when input.reasoning is present", () => {
      const input: Record<string, unknown> = {
        command: "ls",
        reasoning: "User wants to see files",
      };
      const result: string = formatToolCallForTelegram("run_cmd", input);
      expect(result).toContain("[reasoning:");
      expect(result).toContain("User wants to see files");
    });

    it("returns just name when key is unknown", () => {
      const input: Record<string, unknown> = { foo: "bar" };
      const result: string = formatToolCallForTelegram("unknown_tool", input);
      expect(result).toBe("unknown_tool");
    });

    it("returns just name when key not in input", () => {
      const input: Record<string, unknown> = {};
      const result: string = formatToolCallForTelegram("run_cmd", input);
      expect(result).toBe("run_cmd");
    });
  });

  describe("formatStepTraceLines", () => {
    it("returns null for empty tool calls array", () => {
      const result: string | null = formatStepTraceLines(1, []);
      expect(result).toBeNull();
    });

    it("includes step number and formatted names", () => {
      const toolCalls: IToolCallSummary[] = [
        { name: "run_cmd", input: { command: "ls" } },
        { name: "send_message", input: { message: "Hello" } },
      ];
      const result: string | null = formatStepTraceLines(2, toolCalls);
      expect(result).toContain("Step 2:");
      expect(result).toContain("run_cmd(ls)");
      expect(result).toContain("send_message(Hello)");
    });

    it("handles single tool call", () => {
      const toolCalls: IToolCallSummary[] = [
        { name: "think", input: { thought: "Let me consider" } },
      ];
      const result: string | null = formatStepTraceLines(1, toolCalls);
      expect(result).toBe("Step 1: think(Let me consider)");
    });
  });

  describe("buildCancelResponseText", () => {
    it("returns nothing-to-cancel message when all flags are false and count is 0", () => {
      const result: string = buildCancelResponseText(false, false, 0);
      expect(result).toBe("Nothing to cancel.");
    });

    it("returns composed details when stopped is true", () => {
      const result: string = buildCancelResponseText(true, false, 0);
      expect(result).toBe("Cancelled: stopped current generation.");
    });

    it("returns composed details with multiple flags", () => {
      const result: string = buildCancelResponseText(true, true, 3);
      expect(result).toContain("stopped current generation");
      expect(result).toContain("deleted progress message");
      expect(result).toContain("cleared 3 queued messages");
    });

    it("handles pluralization for queued messages", () => {
      const result: string = buildCancelResponseText(false, false, 1);
      expect(result).toBe("Cancelled: cleared 1 queued message.");
    });
  });

  describe("escapeTelegramHtml", () => {
    it("escapes ampersand", () => {
      expect(escapeTelegramHtml("A & B")).toBe("A &amp; B");
    });

    it("escapes less than", () => {
      expect(escapeTelegramHtml("A < B")).toBe("A &lt; B");
    });

    it("escapes greater than", () => {
      expect(escapeTelegramHtml("A > B")).toBe("A &gt; B");
    });

    it("escapes all special characters together", () => {
      expect(escapeTelegramHtml("<tag> & \"quote\"")).toBe("&lt;tag&gt; &amp; \"quote\"");
    });
  });

  describe("detectThinkLeakInModelText", () => {
    it("detects think tags", () => {
      const result = detectThinkLeakInModelText("Some text <think>hidden</think> more text");
      expect(result.hasThinkTags).toBe(true);
    });

    it("detects reasoning tags case-insensitively", () => {
      const result = detectThinkLeakInModelText("<THINKING>content</THINKING>");
      expect(result.hasThinkTags).toBe(true);
    });

    it("detects reasoning phrases", () => {
      const result = detectThinkLeakInModelText("Let me think about this...");
      expect(result.hasReasoningPhrases).toBe(true);
    });

    it("detects multiple reasoning phrases", () => {
      const result = detectThinkLeakInModelText("I should consider that the user is asking me to...");
      expect(result.hasReasoningPhrases).toBe(true);
    });

    it("returns false when no leaks present", () => {
      const result = detectThinkLeakInModelText("The weather is nice today.");
      expect(result.hasThinkTags).toBe(false);
      expect(result.hasReasoningPhrases).toBe(false);
    });
  });

  describe("escapeTelegramHtml", () => {
    it("escapes &, <, > characters", () => {
      const result = escapeTelegramHtml("A & B <tag>");
      expect(result).toContain("&amp;");
      expect(result).toContain("&lt;");
      expect(result).toContain("&gt;");
      expect(result).not.toContain("<tag>");
    });
  });
});
