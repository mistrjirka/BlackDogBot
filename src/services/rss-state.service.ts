import fs from "node:fs/promises";

import { IRssState } from "../shared/types/index.js";
import { getRssStateFilePath, ensureDirectoryExistsAsync, getRssStateDir } from "../utils/paths.js";
import { LoggerService } from "./logger.service.js";

export class RssStateService {
  //#region Data members

  private static _instance: RssStateService | null;
  private _logger: LoggerService;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): RssStateService {
    if (!RssStateService._instance) {
      RssStateService._instance = new RssStateService();
    }

    return RssStateService._instance;
  }

  public async loadStateAsync(feedUrl: string): Promise<IRssState | null> {
    const filePath: string = getRssStateFilePath(feedUrl);

    try {
      const content: string = await fs.readFile(filePath, "utf-8");
      const state: IRssState = JSON.parse(content) as IRssState;

      return state;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      this._logger.warn("Failed to load RSS state", { feedUrl, error: String(error) });

      return null;
    }
  }

  public async saveStateAsync(feedUrl: string, seenIds: string[]): Promise<void> {
    await ensureDirectoryExistsAsync(getRssStateDir());

    const filePath: string = getRssStateFilePath(feedUrl);
    const state: IRssState = {
      feedUrl,
      seenIds,
      lastFetchedAt: new Date().toISOString(),
    };

    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
  }

  public filterUnseenItems(
    items: Record<string, unknown>[],
    state: IRssState | null,
  ): Record<string, unknown>[] {
    if (!state || state.seenIds.length === 0) {
      return items;
    }

    const seenSet: Set<string> = new Set<string>(state.seenIds);

    return items.filter((item: Record<string, unknown>): boolean => {
      const itemId: string | null = this._extractItemId(item);

      if (!itemId) {
        // Items without an ID are always treated as unseen
        return true;
      }

      return !seenSet.has(itemId);
    });
  }

  public mergeSeenIds(
    existingIds: string[],
    newItems: Record<string, unknown>[],
  ): string[] {
    const merged: Set<string> = new Set<string>(existingIds);

    for (const item of newItems) {
      const itemId: string | null = this._extractItemId(item);

      if (itemId) {
        merged.add(itemId);
      }
    }

    return Array.from(merged);
  }

  //#endregion Public methods

  //#region Private methods

  private _extractItemId(item: Record<string, unknown>): string | null {
    // RSS 2.0 uses <guid>, Atom uses <id>
    if (typeof item.guid === "string" && item.guid.length > 0) {
      return item.guid;
    }

    if (typeof item.id === "string" && item.id.length > 0) {
      return item.id;
    }

    // Fallback: use link as a unique identifier
    if (typeof item.link === "string" && item.link.length > 0) {
      return item.link;
    }

    return null;
  }

  //#endregion Private methods
}
