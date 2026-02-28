import { describe, it, expect } from "vitest";
import { parseRssFeed } from "../../src/utils/rss-parser.js";

describe("parseRssFeed", () => {
  describe("RSS 2.0 with content:encoded (tgfeed)", () => {
    const tgfeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>RAGE X - Urgent | Alerts</title>
    <link>https://t.me/s/rageintel</link>
    <description></description>
    <item>
      <title>⚠️🚨#Breaking…</title>
      <link>https://t.me/rageintel/26927</link>
      <description></description>
      <content:encoded><![CDATA[⚠️🚨<a href="?q=%23Breaking">#Breaking</a>:  <br/><br/>🇦🇪❌🇮🇷 — The United Arab Emirates says it reserves the right to respond to the Iranian missile attack.<br/><br/>Stay informed. Follow <a href="https://t.me/rageintel" target="_blank">@rageintel</a>]]></content:encoded>
      <guid>https://t.me/rageintel/26927</guid>
      <pubDate>Sat, 28 Feb 2026 10:08:05 +0000</pubDate>
    </item>
    <item>
      <title>⚠️🚨#Breaking…</title>
      <link>https://t.me/rageintel/26928</link>
      <description></description>
      <content:encoded><![CDATA[⚠️🚨<a href="?q=%23Breaking">#Breaking</a>: Second message with <b>bold text</b> and <i>italic text</i>.<br/><br/>Also has a <a href="https://example.com">link</a>.]]></content:encoded>
      <guid>https://t.me/rageintel/26928</guid>
      <pubDate>Sat, 28 Feb 2026 10:09:04 +0000</pubDate>
    </item>
    <item>
      <title>Normal title</title>
      <link>https://t.me/rageintel/26929</link>
      <description><![CDATA[This is a description field]]></description>
      <content:encoded><![CDATA[<p>This is content:encoded with HTML.</p><ul><li>Item 1</li><li>Item 2</li></ul>]]></content:encoded>
      <guid>https://t.me/rageintel/26929</guid>
      <pubDate>Sat, 28 Feb 2026 10:10:00 +0000</pubDate>
      <category>news</category>
      <author>test@example.com</author>
    </item>
    <item>
      <title>Item with only description</title>
      <link>https://t.me/rageintel/26930</link>
      <description><![CDATA[Just a description, no content:encoded]]></description>
      <guid>https://t.me/rageintel/26930</guid>
      <pubDate>Sat, 28 Feb 2026 10:11:00 +0000</pubDate>
    </item>
    <item>
      <title>Empty content item</title>
      <link>https://t.me/rageintel/26931</link>
      <description></description>
      <content:encoded><![CDATA[]]></content:encoded>
      <guid>https://t.me/rageintel/26931</guid>
      <pubDate>Sat, 28 Feb 2026 10:12:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

    it("should extract feed title", () => {
      const result = parseRssFeed(tgfeedXml);
      expect(result.title).toBe("RAGE X - Urgent | Alerts");
    });

    it("should extract feed link", () => {
      const result = parseRssFeed(tgfeedXml);
      expect(result.link).toBe("https://t.me/s/rageintel");
    });

    it("should extract all 5 items", () => {
      const result = parseRssFeed(tgfeedXml);
      expect(result.items).toHaveLength(5);
    });

    it("should extract content:encoded field", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      
      expect(items[0]["content:encoded"]).toBeDefined();
      expect(items[0]["content:encoded"]).toContain("The United Arab Emirates says");
    });

    it("should NOT trim content:encoded - should contain full text", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      
      // The content should have the full text including "Stay informed. Follow"
      expect(items[0]["content:encoded"]).toContain("Stay informed. Follow");
      expect(items[0]["content:encoded"]).toContain("@rageintel");
    });

    it("should extract all standard fields: title, link, description, guid, pubDate", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      const firstItem = items[0];

      expect(firstItem.title).toBe("⚠️🚨#Breaking…");
      expect(firstItem.link).toBe("https://t.me/rageintel/26927");
      expect(firstItem.description).toBe("");
      expect(firstItem.guid).toBe("https://t.me/rageintel/26927");
      expect(firstItem.pubDate).toBe("Sat, 28 Feb 2026 10:08:05 +0000");
    });

    it("should extract extra fields like category and author", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      const thirdItem = items[2];

      expect(thirdItem.category).toBe("news");
      expect(thirdItem.author).toBe("test@example.com");
    });

    it("should handle description when content:encoded is empty", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      
      // Item 3 has only description, no content:encoded
      const fourthItem = items[3];
      expect(fourthItem["content:encoded"]).toBeUndefined();
      expect(fourthItem.description).toBe("Just a description, no content:encoded");
    });

    it("should handle empty content:encoded field", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      
      // Item 5 has empty content:encoded
      const fifthItem = items[4];
      expect(fifthItem["content:encoded"]).toBe("");
    });

    it("should preserve HTML in content:encoded", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      
      // First item has <br/>, second has <b>, <i>, <a>
      expect(items[0]["content:encoded"]).toContain("<br/>");
      expect(items[1]["content:encoded"]).toContain("<b>");
      expect(items[1]["content:encoded"]).toContain("<i>");
      expect(items[1]["content:encoded"]).toContain("<a href=");
    });

    it("should handle CDATA in all fields", () => {
      const result = parseRssFeed(tgfeedXml);
      const items = result.items as Record<string, string>[];
      
      // Content should have CDATA wrapper removed
      expect(items[0]["content:encoded"]).not.toContain("<![CDATA[");
      expect(items[0]["content:encoded"]).not.toContain("]]>");
    });
  });

  describe("Atom feed", () => {
    const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <subtitle>Atom feed description</subtitle>
  <link href="https://example.com/feed" rel="alternate"/>
  <link href="https://example.com/feed/atom" rel="self"/>
  <entry>
    <title>Entry Title</title>
    <link href="https://example.com/entry/1"/>
    <id>urn:uuid:1</id>
    <updated>2026-02-28T10:00:00Z</updated>
    <content><![CDATA[<p>Full content here</p>]]></content>
    <summary><![CDATA[Short summary]]></summary>
  </entry>
  <entry>
    <title>Second Entry</title>
    <link href="https://example.com/entry/2"/>
    <id>urn:uuid:2</id>
    <published>2026-02-27T10:00:00Z</published>
    <content type="html"><![CDATA[<strong>HTML content</strong>]]></content>
  </entry>
</feed>`;

    it("should extract feed title and description", () => {
      const result = parseRssFeed(atomXml);
      expect(result.title).toBe("Example Atom Feed");
      expect(result.description).toBe("Atom feed description");
    });

    it("should extract all entry fields", () => {
      const result = parseRssFeed(atomXml);
      const items = result.items as Record<string, string>[];

      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("Entry Title");
      expect(items[0].content).toBe("<p>Full content here</p>");
      expect(items[0].summary).toBe("Short summary");
    });

    it("should extract content from Atom entries", () => {
      const result = parseRssFeed(atomXml);
      const items = result.items as Record<string, string>[];

      expect(items[1].content).toBe("<strong>HTML content</strong>");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty feed", () => {
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty Feed</title>
    <link>https://example.com</link>
  </channel>
</rss>`;
      const result = parseRssFeed(emptyXml);
      expect(result.title).toBe("Empty Feed");
      expect(result.items).toHaveLength(0);
    });

    it("should handle item with no title", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>https://example.com</link>
    <item>
      <link>https://example.com/1</link>
      <content:encoded><![CDATA[Content only]]></content:encoded>
    </item>
  </channel>
</rss>`;
      const result = parseRssFeed(xml);
      const items = result.items as Record<string, string>[];
      expect(items[0].title).toBeUndefined();
      expect(items[0].link).toBe("https://example.com/1");
      expect(items[0]["content:encoded"]).toBe("Content only");
    });
  });
});
