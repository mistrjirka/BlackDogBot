import fs from "node:fs/promises";

import { IRssState } from "../shared/types/index.js";
import { getRssStateFilePath, ensureDirectoryExistsAsync, getRssStateDir } from "../utils/paths.js";
import { LoggerService } from "../services/logger.service.js";

//#region Public Functions

export async function loadRssStateAsync(feedUrl: string): Promise<IRssState | null> {
  const filePath: string = getRssStateFilePath(feedUrl);
  const logger: LoggerService = LoggerService.getInstance();

  try {
    const content: string = await fs.readFile(filePath, "utf-8");
    const state: IRssState = JSON.parse(content) as IRssState;

    return state;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    logger.warn("Failed to load RSS state", { feedUrl, error: String(error) });

    return null;
  }
}

export async function saveRssStateAsync(feedUrl: string, seenIds: string[]): Promise<void> {
  await ensureDirectoryExistsAsync(getRssStateDir());

  const filePath: string = getRssStateFilePath(feedUrl);
  const state: IRssState = {
    feedUrl,
    seenIds,
    lastFetchedAt: new Date().toISOString(),
  };

  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export function filterUnseenRssItems(
  items: Record<string, unknown>[],
  state: IRssState | null,
): Record<string, unknown>[] {
  if (!state || state.seenIds.length === 0) {
    return items;
  }

  const seenSet: Set<string> = new Set<string>(state.seenIds);

  return items.filter((item: Record<string, unknown>): boolean => {
    const itemId: string | null = extractRssItemId(item);

    if (!itemId) {
      return true;
    }

    return !seenSet.has(itemId);
  });
}

export function mergeRssSeenIds(
  existingIds: string[],
  newItems: Record<string, unknown>[],
): string[] {
  const merged: Set<string> = new Set<string>(existingIds);

  for (const item of newItems) {
    const itemId: string | null = extractRssItemId(item);

    if (itemId) {
      merged.add(itemId);
    }
  }

  return Array.from(merged);
}

//#endregion Public Functions

//#region Private Functions

function extractRssItemId(item: Record<string, unknown>): string | null {
  if (typeof item.guid === "string" && item.guid.length > 0) {
    return item.guid;
  }

  if (typeof item.id === "string" && item.id.length > 0) {
    return item.id;
  }

  if (typeof item.link === "string" && item.link.length > 0) {
    return item.link;
  }

  return null;
}

//#endregion Private Functions
