import { tool } from "ai";
import TurndownService from "turndown";

import { fetchRssToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { parseRssFeed } from "../utils/rss-parser.js";
import * as rssState from "../helpers/rss-state.js";
import type { IRssState } from "../shared/types/index.js";

// Initialize Turndown service for HTML to Markdown conversion
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Add custom rule for Telegram links (e.g., ?q=%23Breaking -> #Breaking)
turndownService.addRule("telegramLinks", {
  filter: "a",
  replacement: function (content, node: any) {
    const href = node.getAttribute("href");
    if (href && href.startsWith("?q=")) {
      // Decode URL-encoded hashtags/mentions (e.g., ?q=%23Breaking -> #Breaking)
      const decoded = decodeURIComponent(href.substring(3));
      return `${content} (${decoded})`;
    }
    if (href) {
      return `[${content}](${href})`;
    }
    return content;
  },
});

// Handle <br> tags - convert to markdown line breaks
turndownService.addRule("br", {
  filter: "br",
  replacement: function () {
    return "  \n";
  },
});

//#region Interfaces

interface IFetchRssResult {
  title?: string;
  description?: string;
  link?: string;
  items: Record<string, unknown>[];
  totalItems: number;
  feedUrl: string;
  mode: string;
  unseenCount?: number;
}

//#endregion Interfaces

//#region Helper Functions

function transformItem(item: Record<string, unknown>): Record<string, unknown> {
  const transformed = { ...item };

  // Determine primary content source (priority: content:encoded > content > description)
  const contentEncoded = transformed["content:encoded"] as string | undefined;
  const content = transformed.content as string | undefined;
  const description = transformed.description as string | undefined;

  const rawHtml = contentEncoded || content || description || "";

  // Convert HTML to Markdown if there's content
  if (rawHtml) {
    transformed.contentMarkdown = turndownService.turndown(rawHtml);
    transformed.rawHtml = rawHtml;
  }

  // Ensure we have a content field for convenience (prefer content:encoded)
  if (!transformed.content && rawHtml) {
    transformed.content = rawHtml;
  }

  return transformed;
}

//#endregion Helper Functions

//#region Tool

export const fetchRssTool = tool({
  description:
    "Fetch and parse an RSS or Atom feed. Returns feed metadata and items. Use mode='unseen' to only get new items since the last fetch (state is persisted per URL).",
  inputSchema: fetchRssToolInputSchema,
  execute: async ({ url, maxItems, mode }): Promise<IFetchRssResult> => {
    const response: Response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/rss+xml, application/xml, application/atom+xml, text/xml",
        "User-Agent": "BetterClaw/1.0",
      },
    });

    if (!response.ok) {
      const errorText: string = await response.text();
      throw new Error(`RSS fetch failed (${response.status}): ${errorText}`);
    }

    const xmlText: string = await response.text();
    const parsed: Record<string, unknown> = parseRssFeed(xmlText);
    const allItems: Record<string, unknown>[] = (parsed.items ?? []) as Record<string, unknown>[];

    // Transform all items to add markdown content
    const transformedAllItems = allItems.map(transformItem);

    let returnedItems: Record<string, unknown>[];
    let unseenCount: number | undefined;

    if (mode === "unseen") {
      const state: IRssState | null = await rssState.loadRssStateAsync(url);
      const unseenItems: Record<string, unknown>[] = rssState.filterUnseenRssItems(transformedAllItems, state);

      unseenCount = unseenItems.length;
      returnedItems = unseenItems.slice(0, maxItems);

      const updatedSeenIds: string[] = rssState.mergeRssSeenIds(state?.seenIds ?? [], allItems);
      await rssState.saveRssStateAsync(url, updatedSeenIds);
    } else {
      returnedItems = transformedAllItems.slice(0, maxItems);
    }

    const output: IFetchRssResult = {
      title: parsed.title as string | undefined,
      description: parsed.description as string | undefined,
      link: parsed.link as string | undefined,
      items: returnedItems,
      totalItems: allItems.length,
      feedUrl: url,
      mode,
    };

    if (unseenCount !== undefined) {
      output.unseenCount = unseenCount;
    }

    return output;
  },
});

//#endregion Tool
