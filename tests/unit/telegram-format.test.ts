import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, stripAllHtml, preprocessThinkTags, wrapMarkdownTablesInCodeBlocks, convertTablesToBulletLists } from "../../src/utils/telegram-format.js";

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

    it("should strip unsupported hr tags generated from markdown separators", () => {
      const result = markdownToTelegramHtml("before\n\n---\n\nafter");
      expect(result).toContain("before");
      expect(result).toContain("after");
      expect(result).not.toContain("<hr>");
      expect(result).not.toContain("</hr>");
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

describe("wrapMarkdownTablesInCodeBlocks", () => {
  it("should wrap a simple markdown table in code blocks", () => {
    const input = `| Header1 | Header2 |
|---------|---------|
| Cell1   | Cell2   |`;
    const result = wrapMarkdownTablesInCodeBlocks(input);
    expect(result).toBe("```\n| Header1 | Header2 |\n|---------|---------|\n| Cell1   | Cell2   |\n```");
  });

  it("should not wrap tables already inside code blocks", () => {
    const input = "```\n| Header1 | Header2 |\n|---------|---------|\n| Cell1   | Cell2   |\n```";
    const result = wrapMarkdownTablesInCodeBlocks(input);
    expect(result).toBe(input); // Should remain unchanged
  });

  it("should handle multiple tables", () => {
    const input = `| A | B |
|---|---|
| 1 | 2 |

Some text

| C | D |
|---|---|
| 3 | 4 |`;
    const result = wrapMarkdownTablesInCodeBlocks(input);
    const lines = result.split('\n');
    // Should have two code blocks
    const codeBlockCount = lines.filter(line => line.trim() === '```').length;
    expect(codeBlockCount).toBe(4); // Opening and closing for each table
  });

  it("should not treat spoiler delimiters as table rows", () => {
    const input = "||hidden text||";
    const result = wrapMarkdownTablesInCodeBlocks(input);
    expect(result).toBe(input);
  });

  it("should handle tables with extra spaces", () => {
    const input = `  | Col1 | Col2 |
  |------|------|
  | A    | B    |`;
    const result = wrapMarkdownTablesInCodeBlocks(input);
    expect(result).toContain("```");
    expect(result).toContain("| Col1 | Col2 |");
  });

  it("should not wrap single line that looks like table row", () => {
    const input = "| Just one row |";
    const result = wrapMarkdownTablesInCodeBlocks(input);
    expect(result).toBe(input);
  });

  it("should handle tables at start and end of text", () => {
    const input = `| Start | Table |
|-------|-------|
| data  | here  |

Middle text

| End | Table |
|-----|-------|
| foo | bar   |`;
    const result = wrapMarkdownTablesInCodeBlocks(input);
    expect(result).toContain("```");
    // Ensure both tables are wrapped: each table adds 2 backtick fences (opening and closing)
    const codeBlocks = result.split('```').length - 1;
    expect(codeBlocks).toBe(4); // 2 per table = 4 total
  });
});

describe("convertTablesToBulletLists", () => {
  it("should convert a simple markdown table to bullet list", () => {
    const input = `| Header1 | Header2 |
|---------|---------|
| Cell1   | Cell2   |`;
    const result = convertTablesToBulletLists(input);
    // Should contain bullet points
    expect(result).toContain("•");
    // Should contain headers
    expect(result).toContain("Header1");
    expect(result).toContain("Header2");
    // Should contain cells
    expect(result).toContain("Cell1");
    expect(result).toContain("Cell2");
    // Should not contain pipe characters (original table format)
    expect(result).not.toContain("|");
  });

  it("should not convert tables already inside code blocks", () => {
    const input = "```\n| Header1 | Header2 |\n|---------|---------|\n| Cell1   | Cell2   |\n```";
    const result = convertTablesToBulletLists(input);
    // Should remain unchanged
    expect(result).toBe(input);
  });

  it("should handle multiple tables", () => {
    const input = `| A | B |
|---|---|
| 1 | 2 |

Some text

| C | D |
|---|---|
| 3 | 4 |`;
    const result = convertTablesToBulletLists(input);
    // Should contain bullet points for both tables
    const bulletCount = (result.match(/•/g) || []).length;
    expect(bulletCount).toBeGreaterThanOrEqual(2);
    // Should contain all cell content
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("C");
    expect(result).toContain("D");
  });

  it("should not treat spoiler delimiters as table rows", () => {
    const input = "||hidden text||";
    const result = convertTablesToBulletLists(input);
    // Should remain unchanged
    expect(result).toBe(input);
  });

  it("should handle tables with extra spaces", () => {
    const input = `  | Col1 | Col2 |
  |------|------|
  | A    | B    |`;
    const result = convertTablesToBulletLists(input);
    // Should contain bullet points
    expect(result).toContain("•");
    // Should contain column headers
    expect(result).toContain("Col1");
    expect(result).toContain("Col2");
  });

  it("should not convert single line that looks like table row", () => {
    const input = "| Just one row |";
    const result = convertTablesToBulletLists(input);
    // Should remain unchanged (not a valid table)
    expect(result).toBe(input);
  });

  it("should handle tables at start and end of text", () => {
    const input = `| Start | Table |
|-------|-------|
| data  | here  |

Middle text

| End | Table |
|-----|-------|
| foo | bar   |`;
    const result = convertTablesToBulletLists(input);
    // Should contain bullet points for both tables
    const bulletCount = (result.match(/•/g) || []).length;
    expect(bulletCount).toBeGreaterThanOrEqual(2);
    // Should contain all cell content
    expect(result).toContain("Start");
    expect(result).toContain("Table");
    expect(result).toContain("data");
    expect(result).toContain("here");
    expect(result).toContain("End");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("should preserve inline formatting in table cells", () => {
    const input = `| Name | Status |
|------|--------|
| **Bold** | *Italic* |`;
    const result = convertTablesToBulletLists(input);
    // Should contain formatting markers
    expect(result).toContain("**Bold**");
    expect(result).toContain("*Italic*");
  });
});

describe("markdownToTelegramHtml with tables", () => {
  it("should convert markdown table to bullet list in Telegram HTML", () => {
    const input = `| Name | Age |
|------|-----|
| Alice | 30 |
| Bob | 25 |`;
    const result = markdownToTelegramHtml(input);
    // Should contain bullet points
    expect(result).toContain("•");
    // Should contain the table text
    expect(result).toContain("Name");
    expect(result).toContain("Age");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    // Should not contain <table> tag
    expect(result).not.toContain("<table>");
    expect(result).not.toContain("<tr>");
    expect(result).not.toContain("<td>");
    // Should not contain code block (pre tag) for simple tables
    expect(result).not.toContain("<pre>");
  });

  it("should preserve tables inside existing code blocks", () => {
    const input = "```\n| Header | Data |\n|--------|------|\n| foo    | bar  |\n```";
    const result = markdownToTelegramHtml(input);
    // Should still be a code block (pre tag)
    expect(result).toContain("<pre>");
    // Should contain the table text
    expect(result).toContain("Header");
    expect(result).toContain("Data");
  });

  it("should handle RSS summary table as bullet list without garbling", () => {
    const input = `📊 Summary

| Feed | URL | Mode | Items Found | Status |
|------|-----|------|-------------|--------|
| Second Source | http://127.0.0.1:8080/i/lists/1482337753052426240/rss | unseen | 101 | ✅ Working |
| RageIntel Telegram | http://10.8.0.9:8080/telegram/channel/rageintel | unseen | 18 | ✅ Working |`;
    const result = markdownToTelegramHtml(input);
    // Should contain bullet points
    expect(result).toContain("•");
    // Should contain the table content
    expect(result).toContain("Feed");
    expect(result).toContain("URL");
    expect(result).toContain("Second Source");
    expect(result).toContain("RageIntel Telegram");
    // Should NOT contain garbled table tag text
    expect(result).not.toContain("table thead tr th");
    expect(result).not.toContain("/tr /thead tbody");
    // Should NOT contain HTML table tags
    expect(result).not.toContain("<table>");
    expect(result).not.toContain("<thead>");
    expect(result).not.toContain("<tbody>");
  });

  it("should handle multiple tables in one message as bullet lists", () => {
    const input = `First table:
| A | B |
|---|---|
| 1 | 2 |

Second table:
| C | D |
|---|---|
| 3 | 4 |`;
    const result = markdownToTelegramHtml(input);
    // Should contain bullet points for each table
    const bulletCount = (result.match(/•/g) || []).length;
    expect(bulletCount).toBeGreaterThanOrEqual(2);
    // Should contain all cell content
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("C");
    expect(result).toContain("D");
  });
});
