import { describe, it, expect } from "vitest";
import { parseRssFeed } from "../../src/utils/rss-parser.js";
import TurndownService from "turndown";

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndownService.addRule("telegramLinks", {
  filter: "a",
  replacement: function (content, node: any) {
    const href = node.getAttribute("href");
    if (href && href.startsWith("?q=")) {
      const decoded = decodeURIComponent(href.substring(3));
      return `${content} (${decoded})`;
    }
    if (href) return `[${content}](${href})`;
    return content;
  },
});
turndownService.addRule("br", {
  filter: "br",
  replacement: function () {
    return "  \n";
  },
});

describe("RSS Parser output demonstration", () => {
  it("demonstrate what the LLM sees", () => {
    const tgfeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>RAGE X - Urgent | Alerts</title>
    <link>https://t.me/s/rageintel</link>
    <item>
      <title>⚠️🚨#Breaking…</title>
      <link>https://t.me/rageintel/26927</link>
      <description></description>
      <content:encoded><![CDATA[⚠️🚨<a href="?q=%23Breaking">#Breaking</a>:  <br/><br/>🇦🇪❌🇮🇷 — The United Arab Emirates says it reserves the right to respond to the Iranian missile attack.<br/><br/>Stay informed. Follow <a href="https://t.me/rageintel" target="_blank">@rageintel</a>]]></content:encoded>
      <guid>https://t.me/rageintel/26927</guid>
      <pubDate>Sat, 28 Feb 2026 10:08:05 +0000</pubDate>
    </item>
  </channel>
</rss>`;

    const parsed = parseRssFeed(tgfeedXml);

    function transformItem(item: Record<string, unknown>): Record<string, unknown> {
      const transformed = { ...item };
      const rawHtml =
        (item["content:encoded"] as string) ||
        (item.content as string) ||
        (item.description as string) ||
        "";

      if (rawHtml) {
        transformed.contentMarkdown = turndownService.turndown(rawHtml);
        transformed.rawHtml = rawHtml;
      }

      if (!transformed.content && rawHtml) {
        transformed.content = rawHtml;
      }

      return transformed;
    }

    const transformed = (parsed.items || []).map(transformItem);

    console.log("=== FULL ITEM OBJECT (what LLM sees) ===");
    console.log(JSON.stringify(transformed[0], null, 2));

    console.log("\n=== contentMarkdown ===");
    console.log(transformed[0].contentMarkdown);

    // Verify content is NOT trimmed
    expect(transformed[0].contentMarkdown).toContain("Stay informed");
    expect(transformed[0].contentMarkdown).toContain("@rageintel");
  });
});
