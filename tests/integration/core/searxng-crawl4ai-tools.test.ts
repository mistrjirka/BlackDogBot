import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { searchSearxngAsync } from "../../../src/utils/searxng-client.js";
import { crawlUrlAsync } from "../../../src/utils/crawl4ai-client.js";
import { searxngTool } from "../../../src/tools/searxng.tool.js";
import { crawl4aiTool } from "../../../src/tools/crawl4ai.tool.js";

//#region Types

type SearxngOutput = { results: string; error?: string };
type Crawl4aiOutput = { content: string; error?: string };

// The `tool()` helper from the ai SDK types execute as potentially undefined and
// the return as T | AsyncIterable<T>. Use explicit casts for tests.
type ToolExecFn<TArgs, TOutput> = (args: TArgs, ctx: { toolCallId: string; messages: unknown[] }) => Promise<TOutput>;

const callSearxng = searxngTool.execute as unknown as ToolExecFn<{ query: string; maxResults?: number; categories?: string[] }, SearxngOutput>;
const callCrawl4ai = crawl4aiTool.execute as unknown as ToolExecFn<{ url: string; selector?: string }, Crawl4aiOutput>;

//#endregion

//#region Setup

let tempDir: string;
let originalHome: string;
let searxngUrl: string | undefined;
let crawl4aiUrl: string | undefined;


beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-tools-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  resetSingletons();

  const realConfigPath = path.join(originalHome, ".betterclaw", "config.yaml");
  const configDir = path.join(tempDir, ".betterclaw");
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

//#region SearXNG client tests

describe("searchSearxngAsync (client)", () => {
  it("should return results for a general query", async () => {
    if (!searxngUrl) {
      console.log("Skipping: services.searxngUrl not configured in config.yaml");
      return;
    }

    const result = await searchSearxngAsync("openai news", { maxResults: 5 });

    expect(result).toBeDefined();
    expect(result.query).toBe("openai news");
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    // Note: SearXNG API often returns number_of_results=0 even with actual results (API quirk)

    const first = result.results[0];
    expect(first).toBeDefined();
    // At least one of url, title, content should be present
    expect(first.url ?? first.title ?? first.content).toBeDefined();
  }, 30_000);

  it("should accept maxResults option and return results", async () => {
    if (!searxngUrl) {
      console.log("Skipping: services.searxngUrl not configured in config.yaml");
      return;
    }

    // Note: SearXNG doesn't always respect max_results param, but client should accept it
    const result = await searchSearxngAsync("typescript", { maxResults: 3 });

    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    // Just verify we got some results (actual count depends on SearXNG engine)
    expect(result.results.length).toBeGreaterThan(0);
  }, 30_000);

  it("should support news category", async () => {
    if (!searxngUrl) {
      console.log("Skipping: services.searxngUrl not configured in config.yaml");
      return;
    }

    const result = await searchSearxngAsync("technology", {
      categories: ["news"],
      maxResults: 5,
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  }, 30_000);
});

//#endregion

//#region SearXNG tool tests

describe("searxngTool (agent tool wrapper)", () => {
  it("should return formatted markdown with search results", async () => {
    if (!searxngUrl) {
      console.log("Skipping: services.searxngUrl not configured in config.yaml");
      return;
    }

    const result = await callSearxng({ query: "openai" }, { toolCallId: "test-1", messages: [] });

    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.results).toContain("## Search Results for");
    expect(result.results).toContain("openai");
  }, 30_000);

  it("should return error object (not throw) when SearXNG is unreachable", async () => {
    if (!searxngUrl) {
      console.log("Skipping: services.searxngUrl not configured in config.yaml");
      return;
    }

    // Temporarily swap URL to a bad address
    const config = ConfigService.getInstance().getConfig();
    const originalUrl = config.services!.searxngUrl;
    config.services!.searxngUrl = "http://127.0.0.1:19999"; // nothing listening here

    const result = await callSearxng({ query: "test" }, { toolCallId: "test-2", messages: [] });

    config.services!.searxngUrl = originalUrl;

    expect(result.error).toBeDefined();
    expect(result.results).toBe("");
  }, 15_000);
});

//#endregion

//#region Crawl4AI client tests

describe("crawlUrlAsync (client)", () => {
  it("should crawl example.com and return markdown content", async () => {
    if (!crawl4aiUrl) {
      console.log("Skipping: services.crawl4aiUrl not configured in config.yaml");
      return;
    }

    const result = await crawlUrlAsync("https://example.com");

    expect(result).toBeDefined();
    expect(result.url).toBe("https://example.com");
    expect(result.success).toBe(true);
    expect(result.markdown).toBeTruthy();
    expect(result.markdown.length).toBeGreaterThan(0);
    // example.com always contains "Example Domain"
    expect(result.markdown.toLowerCase()).toContain("example");
  }, 30_000);

  it("should support css selector to extract specific content", async () => {
    if (!crawl4aiUrl) {
      console.log("Skipping: services.crawl4aiUrl not configured in config.yaml");
      return;
    }

    const result = await crawlUrlAsync("https://example.com", { selector: "body" });

    expect(result.success).toBe(true);
    expect(result.markdown).toBeTruthy();
  }, 30_000);
});

//#endregion

//#region Crawl4AI tool tests

describe("crawl4aiTool (agent tool wrapper)", () => {
  it("should return formatted markdown for a real page", async () => {
    if (!crawl4aiUrl) {
      console.log("Skipping: services.crawl4aiUrl not configured in config.yaml");
      return;
    }

    const result = await callCrawl4ai({ url: "https://example.com" }, { toolCallId: "test-3", messages: [] });

    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('## Crawl Result for "https://example.com"');
    expect(result.content).toContain("**Status:** Success");
    expect(result.content).toContain("### Content");
    expect(result.content.toLowerCase()).toContain("example");
  }, 30_000);

  it("should return error object (not throw) when Crawl4AI is unreachable", async () => {
    if (!crawl4aiUrl) {
      console.log("Skipping: services.crawl4aiUrl not configured in config.yaml");
      return;
    }

    const config = ConfigService.getInstance().getConfig();
    const originalUrl = config.services!.crawl4aiUrl;
    config.services!.crawl4aiUrl = "http://127.0.0.1:19999"; // nothing listening here

    const result = await callCrawl4ai({ url: "https://example.com" }, { toolCallId: "test-4", messages: [] });

    config.services!.crawl4aiUrl = originalUrl;

    expect(result.error).toBeDefined();
    expect(result.content).toBe("");
  }, 15_000);
});

//#endregion
