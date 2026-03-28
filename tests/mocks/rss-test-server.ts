import { createServer, type Server } from "node:http";

export interface RssTestFeed {
  title: string;
  description?: string;
  link?: string;
  items: Array<{
    title: string;
    link: string;
    description?: string;
    pubDate?: string;
    content?: string;
  }>;
}

const defaultFeed: RssTestFeed = {
  title: "Test News Feed",
  description: "A test RSS feed for integration testing",
  link: "http://localhost:3999",
  items: [
    {
      title: "Test Item 1",
      link: "https://example.com/item1",
      description: "First test item",
      pubDate: new Date().toISOString(),
    },
    {
      title: "Test Item 2",
      link: "https://example.com/item2",
      description: "Second test item",
      pubDate: new Date().toISOString(),
    },
    {
      title: "Test Item 3",
      link: "https://example.com/item3",
      description: "Third test item",
      pubDate: new Date().toISOString(),
    },
  ],
};

function formatRss(feed: RssTestFeed): string {
  const items = feed.items
    .map(
      (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <description>${escapeXml(item.description || "")}</description>
      ${item.pubDate ? `<pubDate>${item.pubDate}</pubDate>` : ""}
      ${item.content ? `<content:encoded>${escapeXml(item.content)}</content:encoded>` : ""}
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    ${feed.description ? `<description>${escapeXml(feed.description)}</description>` : ""}
    ${feed.link ? `<link>${escapeXml(feed.link)}</link>` : ""}
    ${items}
  </channel>
</rss>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function createRssTestServer(port: number = 3999): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url || "/";

    if (url.startsWith("/rss/news")) {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(formatRss(defaultFeed));
      return;
    }

    if (url.startsWith("/rss/tech")) {
      const techFeed: RssTestFeed = {
        ...defaultFeed,
        title: "Tech News Feed",
        items: [
          {
            title: "AI Breakthrough in Code Generation",
            link: "https://example.com/ai-code",
            description: "New AI model generates production-ready code",
            pubDate: new Date().toISOString(),
          },
          {
            title: "Quantum Computing Milestone",
            link: "https://example.com/quantum",
            description: "Scientists achieve quantum supremacy",
            pubDate: new Date().toISOString(),
          },
        ],
      };
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(formatRss(techFeed));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}