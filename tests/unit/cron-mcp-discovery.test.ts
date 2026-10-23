import { afterEach, describe, expect, it, vi } from "vitest";
import { McpService } from "../../src/services/mcp.service.js";
import { buildCronToolContextBlockAsync } from "../../src/utils/cron-tool-context.js";
import { filterInvalidTools, getAvailableCronToolNames, getMissingCronTools } from "../../src/utils/cron-tool-validation.js";

describe("Cron MCP discovery and availability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts connected Scrapling and search tools and rejects removed Crawl4AI tools", () => {
    vi.spyOn(McpService.getInstance(), "getTools").mockReturnValue({
      "mcp.scrapling.browser_fetch_once": { description: "Render a web page" },
      "mcp.searxng.searxng_web_search": { description: "Search" },
    } as never);
    expect(filterInvalidTools([
      "send_message", "mcp.scrapling.browser_fetch_once", "mcp.searxng.searxng_web_search",
    ])).toEqual([]);
    expect(filterInvalidTools(["mcp.crawl4ai.md", "mcp.scrapling.unknown"]))
      .toEqual(["mcp.crawl4ai.md", "mcp.scrapling.unknown"]);
    expect(getAvailableCronToolNames()).toContain("mcp.scrapling.browser_fetch_once");
    expect(getAvailableCronToolNames()).not.toContain("mcp.crawl4ai.md");
  });

  it("allows the legacy SearXNG alias only while its replacement is connected", () => {
    const spy = vi.spyOn(McpService.getInstance(), "getTools").mockReturnValue({} as never);
    expect(filterInvalidTools(["searxng"])).toEqual(["searxng"]);
    spy.mockReturnValue({ "mcp.searxng.searxng_web_search": { description: "Search" } } as never);
    expect(filterInvalidTools(["searxng"])).toEqual([]);
  });

  it("detects unavailable required tools before executing the scheduled agent", () => {
    const available = { send_message: {}, "mcp.searxng.searxng_web_search": {} };
    expect(getMissingCronTools(["send_message", "searxng", "delegate_agent"], available)).toEqual([]);
    expect(getMissingCronTools(["send_message", "mcp.scrapling.browser_fetch_once"], available))
      .toEqual(["mcp.scrapling.browser_fetch_once"]);
  });

  it("uses actual connected MCP descriptions in task instruction verification", async () => {
    vi.spyOn(McpService.getInstance(), "getTools").mockReturnValue({
      "mcp.scrapling.browser_fetch_once": { description: "Render the requested URL with a browser and extract text." },
    } as never);
    const ctx = await buildCronToolContextBlockAsync(["mcp.scrapling.browser_fetch_once"]);
    expect(ctx).toContain("Render the requested URL with a browser");
    expect(ctx).not.toContain("no description available");
  });
});
