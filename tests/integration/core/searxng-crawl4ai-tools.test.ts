/**
 * SearXNG and Crawl4AI Client Connectivity Tests
 *
 * These tests verify direct client connectivity to configured servers.
 * LLM-based tests for these tools are in tests/integration/tools/tool-coverage.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { searchSearxngAsync } from "../../../src/utils/searxng-client.js";
import { crawlUrlAsync } from "../../../src/utils/crawl4ai-client.js";

//#region Setup

let tempDir: string;
let originalHome: string;
let searxngUrl: string | undefined;
let crawl4aiUrl: string | undefined;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-tools-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  resetSingletons();

  const realConfigPath = path.join(originalHome, ".blackdogbot", "config.yaml");
  const configDir = path.join(tempDir, ".blackdogbot");
  await fs.mkdir(configDir, { recursive: true });
  await fs.copyFile(realConfigPath, path.join(configDir, "config.yaml"));

  const logsPath = path.join(tempDir, "logs");
  await fs.mkdir(logsPath, { recursive: true });

  await LoggerService.getInstance().initializeAsync("info", logsPath);

  const configPath = path.join(configDir, "config.yaml");
  await ConfigService.getInstance().initializeAsync(configPath);

  const config = ConfigService.getInstance().getConfig();
  searxngUrl = config.services?.searxngUrl;
  crawl4aiUrl = config.services?.crawl4aiUrl;
});

afterAll(async () => {
  process.env.HOME = originalHome;
  resetSingletons();
  await fs.rm(tempDir, { recursive: true, force: true });
});

//#endregion

//#region SearXNG Client Tests

describe("SearXNG Client Connectivity", () => {
  it("should connect to SearXNG and return results", async () => {
    if (!searxngUrl) {
      console.log("Skipping: services.searxngUrl not configured");
      return;
    }

    const result = await searchSearxngAsync("openai", { maxResults: 5 });

    expect(result).toBeDefined();
    expect(result.query).toBe("openai");
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);

    const first = result.results[0];
    expect(first.url ?? first.title ?? first.content).toBeDefined();
  }, 30000);

  it("should support news category", async () => {
    if (!searxngUrl) {
      console.log("Skipping: services.searxngUrl not configured");
      return;
    }

    const result = await searchSearxngAsync("technology", {
      categories: ["news"],
      maxResults: 5,
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  }, 30000);
});

//#endregion

//#region Crawl4AI Client Tests

describe("Crawl4AI Client Connectivity", () => {
  it("should crawl example.com and return markdown", async () => {
    if (!crawl4aiUrl) {
      console.log("Skipping: services.crawl4aiUrl not configured");
      return;
    }

    const result = await crawlUrlAsync("https://example.com");

    expect(result).toBeDefined();
    expect(result.url).toBe("https://example.com");
    expect(result.success).toBe(true);
    expect(result.markdown).toBeTruthy();
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.markdown.toLowerCase()).toContain("example");
  }, 30000);

  it("should support CSS selector", async () => {
    if (!crawl4aiUrl) {
      console.log("Skipping: services.crawl4aiUrl not configured");
      return;
    }

    const result = await crawlUrlAsync("https://example.com", { selector: "body" });

    expect(result.success).toBe(true);
    expect(result.markdown).toBeTruthy();
  }, 30000);
});

//#endregion