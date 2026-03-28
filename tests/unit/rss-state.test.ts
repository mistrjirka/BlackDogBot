import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  loadRssStateAsync,
  saveRssStateAsync,
  filterUnseenRssItems,
} from "../../src/helpers/rss-state.js";
import { LoggerService } from "../../src/services/logger.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-rss-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  await fs.mkdir(path.join(tempDir, ".blackdogbot", "rss-state"), { recursive: true });

  const logger: LoggerService = LoggerService.getInstance();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

function getRssStateFilePath(feedUrl: string): string {
  const hash: string = crypto.createHash("sha256").update(feedUrl).digest("hex");
  return path.join(tempDir, ".blackdogbot", "rss-state", `${hash}.json`);
}

//#endregion Helpers

//#region Tests

describe("RSS state", () => {
  const feedUrl = "https://example.com/rss";

  beforeEach(async () => {
    await setupTempHomeAsync();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  describe("loadRssStateAsync", () => {
    it("should return null when state file does not exist", async () => {
      const state = await loadRssStateAsync(feedUrl);
      expect(state).toBeNull();
    });

    it("should load valid state file", async () => {
      await saveRssStateAsync(feedUrl, ["guid1", "guid2"]);

      const state = await loadRssStateAsync(feedUrl);
      expect(state).not.toBeNull();
      expect(state?.seenGuids).toEqual(["guid1", "guid2"]);
      expect(state?.feedUrl).toBe(feedUrl);
    });

    it("should delete corrupted state file and return null", async () => {
      const hash: string = crypto.createHash("sha256").update(feedUrl).digest("hex");
      const filePath = path.join(tempDir, ".blackdogbot", "rss-state", `${hash}.json`);

      // Write corrupted state (missing seenGuids)
      await fs.writeFile(filePath, '{"feedUrl":"https://example.com/rss"}');

      const state = await loadRssStateAsync(feedUrl);
      expect(state).toBeNull();

      // Verify file was deleted
      const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    });

    it("should delete state file with invalid seenGuids type and return null", async () => {
      const hash: string = crypto.createHash("sha256").update(feedUrl).digest("hex");
      const filePath = path.join(tempDir, ".blackdogbot", "rss-state", `${hash}.json`);

      // Write corrupted state (seenGuids is not an array)
      await fs.writeFile(filePath, '{"feedUrl":"https://example.com/rss","seenGuids":"not-an-array"}');

      const state = await loadRssStateAsync(feedUrl);
      expect(state).toBeNull();

      // Verify file was deleted
      const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    });

    it("should delete empty state file and return null", async () => {
      const hash: string = crypto.createHash("sha256").update(feedUrl).digest("hex");
      const filePath = path.join(tempDir, ".blackdogbot", "rss-state", `${hash}.json`);

      // Write empty JSON object
      await fs.writeFile(filePath, "{}");

      const state = await loadRssStateAsync(feedUrl);
      expect(state).toBeNull();

      // Verify file was deleted
      const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    });

    it("should recover after deleting corrupted state file", async () => {
      const hash: string = crypto.createHash("sha256").update(feedUrl).digest("hex");
      const filePath = path.join(tempDir, ".blackdogbot", "rss-state", `${hash}.json`);

      // Write corrupted state
      await fs.writeFile(filePath, '{"feedUrl":"https://example.com/rss"}');

      // First load should delete corrupted file and return null
      const state1 = await loadRssStateAsync(feedUrl);
      expect(state1).toBeNull();

      // Save valid state
      await saveRssStateAsync(feedUrl, ["guid1"]);

      // Second load should return valid state
      const state2 = await loadRssStateAsync(feedUrl);
      expect(state2).not.toBeNull();
      expect(state2?.seenGuids).toEqual(["guid1"]);
    });
  });

  describe("filterUnseenRssItems", () => {
    it("should return all items when state is null", () => {
      const items = [{ guid: "1" }, { guid: "2" }];
      const filtered = filterUnseenRssItems(items, null);
      expect(filtered).toEqual(items);
    });

    it("should return all items when state has empty seenGuids", () => {
      const state = { feedUrl, seenGuids: [], lastPublishedDate: null };
      const items = [{ guid: "1" }, { guid: "2" }];
      const filtered = filterUnseenRssItems(items, state);
      expect(filtered).toEqual(items);
    });

    it("should filter seen items", () => {
      const state = { feedUrl, seenGuids: ["1", "3"], lastPublishedDate: null };
      const items = [{ guid: "1" }, { guid: "2" }, { guid: "3" }];
      const filtered = filterUnseenRssItems(items, state);
      expect(filtered).toEqual([{ guid: "2" }]);
    });

    it("should handle malformed state gracefully (defensive check)", () => {
      const state = { feedUrl, seenGuids: undefined as unknown as string[], lastPublishedDate: null };
      const items = [{ guid: "1" }, { guid: "2" }];
      const filtered = filterUnseenRssItems(items, state);
      expect(filtered).toEqual(items);
    });
  });
});

//#endregion Tests
