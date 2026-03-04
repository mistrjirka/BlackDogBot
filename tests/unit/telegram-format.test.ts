import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, stripAllHtml, preprocessThinkTags } from "../../src/utils/telegram-format.js";

describe("preprocessThinkTags", () => {
  it("should convert self-closing <think/> to blockquote", () => {
    const result = preprocessThinkTags("Hello <think/> world");
    expect(result).toContain(">");
  });

  it("should convert <thinking>content</thinking> to blockquote", () => {
    const result = preprocessThinkTags("<thinking>my reasoning</thinking>");
    expect(result).toContain("> my reasoning");
  });

  it("should convert [think]content[/think] to blockquote", () => {
    const result = preprocessThinkTags("[think]my reasoning[/think]");
    expect(result).toContain("> my reasoning");
  });

  it("should convert <reasoning>content</reasoning> to blockquote", () => {
    const result = preprocessThinkTags("<reasoning>step by step</reasoning>");
    expect(result).toContain("> step by step");
  });

  it("should convert <details>content</details> to blockquote", () => {
    const result = preprocessThinkTags("<details>hidden info</details>");
    expect(result).toContain("> hidden info");
  });

  it("should handle multiple think tags", () => {
    const result = preprocessThinkTags("<think/> and <reasoning>test</reasoning>");
    expect(result).toContain(">");
  });
});

describe("markdownToTelegramHtml", () => {
  describe("basic formatting", () => {
    it("should convert bold **text** to HTML", () => {
      const result = markdownToTelegramHtml("**bold text**");
      expect(result).toMatch(/<b>bold text<\/b>|<strong>bold text<\/strong>/);
    });

    it("should convert italic *text* to HTML", () => {
      const result = markdownToTelegramHtml("*italic text*");
      expect(result).toMatch(/<i>italic text<\/i>|<em>italic text<\/em>/);
    });

    it("should convert strikethrough ~~text~~ to HTML", () => {
      const result = markdownToTelegramHtml("~~strikethrough~~");
      expect(result).toMatch(/<s>strikethrough<\/s>|<del>strikethrough<\/del>/);
    });

    it("should convert inline code `text` to HTML", () => {
      const result = markdownToTelegramHtml("`inline code`");
      expect(result).toContain("<code>inline code</code>");
    });

    it("should convert code block to HTML", () => {
      const result = markdownToTelegramHtml("```js\ncode\n```");
      expect(result).toContain("<pre>");
      expect(result).toContain("<code");
    });

    it("should convert links [text](url) to HTML", () => {
      const result = markdownToTelegramHtml("[link text](https://example.com)");
      expect(result).toContain("https://example.com");
      expect(result).toContain("link text");
    });

    it("should convert blockquote > text to HTML", () => {
      const result = markdownToTelegramHtml("> quoted text");
      expect(result).toContain("<blockquote>");
    });

    it("should convert headings to HTML", () => {
      const result = markdownToTelegramHtml("## Heading");
      expect(result).toMatch(/<h2>|<b>/);
    });
  });

  describe("Telegram-specific", () => {
    it("should convert ||spoiler|| to <tg-spoiler>", () => {
      const result = markdownToTelegramHtml("||hidden text||");
      expect(result).toContain("<tg-spoiler>hidden text</tg-spoiler>");
    });
  });

  describe("think tags integration", () => {
    it("should convert <think/> to blockquote in output", () => {
      const result = markdownToTelegramHtml("Hello <think/> world");
      expect(result).toContain("<blockquote>");
    });

    it("should convert <thinking>content</thinking> to blockquote in output", () => {
      const result = markdownToTelegramHtml("<thinking>my reasoning</thinking>");
      expect(result).toContain("<blockquote>");
    });
  });

  describe("edge cases", () => {
    it("should return empty string for empty input", () => {
      expect(markdownToTelegramHtml("")).toBe("");
    });

    it("should return empty string for whitespace-only input", () => {
      expect(markdownToTelegramHtml("   ")).toBe("");
    });

    it("should handle plain text without formatting", () => {
      const result = markdownToTelegramHtml("plain text");
      expect(result).toContain("plain text");
    });

    it("should handle mixed formatting", () => {
      const result = markdownToTelegramHtml("**bold** and *italic* and `code`");
      expect(result).toMatch(/<b>bold<\/b>|<strong>bold<\/strong>/);
      expect(result).toMatch(/<i>italic<\/i>|<em>italic<\/em>/);
      expect(result).toContain("<code>code</code>");
    });

    it("should handle multiline text", () => {
      const result = markdownToTelegramHtml("line1\nline2\nline3");
      expect(result).toContain("line1");
      expect(result).toContain("line2");
      expect(result).toContain("line3");
    });

    it("should handle lists", () => {
      const result = markdownToTelegramHtml("- item1\n- item2");
      expect(result).toContain("item1");
      expect(result).toContain("item2");
    });
  });
});

describe("stripAllHtml", () => {
  it("should remove all HTML tags", () => {
    expect(stripAllHtml("<b>bold</b>")).toBe("bold");
  });

  it("should preserve text content", () => {
    expect(stripAllHtml('<a href="url">link</a> text')).toBe("link text");
  });

  it("should handle nested tags", () => {
    expect(stripAllHtml("<b><i>nested</i></b>")).toBe("nested");
  });

  it("should handle multiple tags", () => {
    expect(stripAllHtml("<b>bold</b> and <i>italic</i>")).toBe("bold and italic");
  });

  it("should handle self-closing tags", () => {
    expect(stripAllHtml("text<br/>more")).toBe("textmore");
  });

  it("should handle empty input", () => {
    expect(stripAllHtml("")).toBe("");
  });
});
