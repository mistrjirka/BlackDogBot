import { describe, it, expect } from "vitest";
import { formatMarkdownForDiscord } from "../../src/utils/discord-format.js";

describe("formatMarkdownForDiscord", () => {
  describe("think tags", () => {
    it("should convert <think/> to blockquote", () => {
      const result = formatMarkdownForDiscord("Hello <think/> world");
      expect(result).toContain(">");
    });

    it("should convert <thinking>content</thinking> to blockquote", () => {
      const result = formatMarkdownForDiscord("<thinking>my reasoning</thinking>");
      expect(result).toContain("> my reasoning");
    });

    it("should convert [think]content[/think] to blockquote", () => {
      const result = formatMarkdownForDiscord("[think]my reasoning[/think]");
      expect(result).toContain("> my reasoning");
    });

    it("should convert <reasoning>content</reasoning> to blockquote", () => {
      const result = formatMarkdownForDiscord("<reasoning>step by step</reasoning>");
      expect(result).toContain("> step by step");
    });

    it("should convert <details>content</details> to blockquote", () => {
      const result = formatMarkdownForDiscord("<details>hidden info</details>");
      expect(result).toContain("> hidden info");
    });
  });

  describe("markdown preservation", () => {
    it("should preserve bold syntax", () => {
      expect(formatMarkdownForDiscord("**bold**")).toBe("**bold**");
    });

    it("should preserve italic syntax", () => {
      expect(formatMarkdownForDiscord("*italic*")).toBe("*italic*");
    });

    it("should preserve strikethrough syntax", () => {
      expect(formatMarkdownForDiscord("~~strike~~")).toBe("~~strike~~");
    });

    it("should preserve inline code syntax", () => {
      expect(formatMarkdownForDiscord("`code`")).toBe("`code`");
    });

    it("should preserve code blocks", () => {
      const input = "```js\ncode\n```";
      expect(formatMarkdownForDiscord(input)).toBe(input);
    });

    it("should preserve links", () => {
      expect(formatMarkdownForDiscord("[text](url)")).toBe("[text](url)");
    });

    it("should preserve spoiler syntax", () => {
      expect(formatMarkdownForDiscord("||spoiler||")).toBe("||spoiler||");
    });

    it("should preserve blockquotes", () => {
      expect(formatMarkdownForDiscord("> quote")).toBe("> quote");
    });

    it("should preserve headings", () => {
      expect(formatMarkdownForDiscord("## Heading")).toBe("## Heading");
    });

    it("should preserve lists", () => {
      const input = "- item1\n- item2";
      expect(formatMarkdownForDiscord(input)).toBe(input);
    });
  });

  describe("edge cases", () => {
    it("should return empty string for empty input", () => {
      expect(formatMarkdownForDiscord("")).toBe("");
    });

    it("should return empty string for whitespace-only input", () => {
      expect(formatMarkdownForDiscord("   ")).toBe("");
    });

    it("should handle plain text", () => {
      expect(formatMarkdownForDiscord("plain text")).toBe("plain text");
    });

    it("should handle mixed content", () => {
      const input = "**bold** and <think/> and `code`";
      const result = formatMarkdownForDiscord(input);
      expect(result).toContain("**bold**");
      expect(result).toContain("`code`");
      expect(result).toContain(">");
    });

    it("should handle multiline text", () => {
      const input = "line1\nline2\nline3";
      expect(formatMarkdownForDiscord(input)).toBe(input);
    });
  });
});
