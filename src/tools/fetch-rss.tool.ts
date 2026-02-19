import { tool } from "ai";

import { fetchRssToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { parseRssFeed } from "../utils/rss-parser.js";
import { RssStateService } from "../services/rss-state.service.js";
import type { IRssState } from "../shared/types/index.js";

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

//#region Tool

export const fetchRssTool = tool({
  description: "Fetch and parse an RSS or Atom feed. Returns feed metadata and items. Use mode='unseen' to only get new items since the last fetch (state is persisted per URL).",
  inputSchema: fetchRssToolInputSchema,
  execute: async ({ url, maxItems, mode }): Promise<IFetchRssResult> => {
    const response: Response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/rss+xml, application/xml, application/atom+xml, text/xml",
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

    let returnedItems: Record<string, unknown>[];
    let unseenCount: number | undefined;

    if (mode === "unseen") {
      const rssStateService: RssStateService = RssStateService.getInstance();
      const state: IRssState | null = await rssStateService.loadStateAsync(url);
      const unseenItems: Record<string, unknown>[] = rssStateService.filterUnseenItems(allItems, state);

      unseenCount = unseenItems.length;
      returnedItems = unseenItems.slice(0, maxItems);

      const updatedSeenIds: string[] = rssStateService.mergeSeenIds(state?.seenIds ?? [], allItems);
      await rssStateService.saveStateAsync(url, updatedSeenIds);
    } else {
      returnedItems = allItems.slice(0, maxItems);
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
