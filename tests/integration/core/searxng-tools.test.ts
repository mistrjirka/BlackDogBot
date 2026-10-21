import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { searchSearxngAsync } from "../../../src/utils/searxng-client.js";
import { searxngTool } from "../../../src/tools/searxng.tool.js";

//#region Types

type SearxngOutput = { results: string; error?: string };

// The `tool()` helper from the ai SDK types execute as potentially undefined and
// the return as T | AsyncIterable<T>. Use explicit casts for tests.
type ToolExecFn<TArgs, TOutput> = (args: TArgs, ctx: { toolCallId: string; messages: unknown[] }) => Promise<TOutput>;

const callSearxng = searxngTool.execute as unknown as ToolExecFn<{ query: string; maxResults?: number; categories?: string[] }, SearxngOutput>;

//#endregion

//#region Setup

let tempDir: string;
let originalHome: string;
let searxngUrl: string | undefined;


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

    // Backend may ignore max_results; the client must enforce it.
    const result = await searchSearxngAsync("typescript", { maxResults: 3 });

    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    // The backend may return fewer than requested, but never more to the tool.
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(3);
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
    expect(result.results).not.toContain("Found undefined results");
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

