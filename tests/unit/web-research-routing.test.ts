import { describe, expect, it } from "vitest";
import { buildWebResearchRoutingInstruction } from "../../src/agent/web-research-routing.js";

describe("web research MCP tool priority", () => {
  const all = [
    "mcp.searxng.searxng_web_search",
    "mcp.searxng.web_url_read",
    "mcp.scrapling.browser_fetch_once",
    "mcp.scrapling.browser_open",
    "mcp.scrapling.browser_screenshot",
    "mcp.playwright.browser_navigate",
  ];

  it("routes source discovery to search, page extraction to Scrapling and interaction to Playwright", () => {
    const route = buildWebResearchRoutingInstruction(all);
    const search = route.indexOf("1. DISCOVER");
    const scrape = route.indexOf("2. READ");
    const browser = route.indexOf("3. ESCALATE");
    expect(search).toBeGreaterThanOrEqual(0);
    expect(scrape).toBeGreaterThan(search);
    expect(browser).toBeGreaterThan(scrape);
    expect(route).toContain("mcp.searxng.searxng_web_search");
    expect(route).toContain("mcp.scrapling.browser_fetch_once");
    expect(route).toContain("mcp.playwright");
    expect(route).toContain("do not jump to a full interactive browser");
    expect(route).toContain("Do not use Playwright as the default");
    expect(route).toContain("skip search");
    expect(route).toContain("HTTP 200 alone");
  });

  it("does not confuse one-shot text with a screenshot and explains the native image tool", () => {
    const route = buildWebResearchRoutingInstruction(all);
    expect(route).toContain("mcp.scrapling.browser_screenshot");
    expect(route).toContain("actual inline PNG image");
    expect(route).toContain("close_session");
    expect(route).toContain("Only claim screenshot/vision PASS");
  });

  it("does not advertise tools that are not connected", () => {
    const route = buildWebResearchRoutingInstruction(["mcp.searxng.searxng_web_search"]);
    expect(route).toContain("mcp.searxng.searxng_web_search");
    expect(route).not.toContain("mcp.scrapling");
    expect(route).not.toContain("mcp.playwright");
    expect(route).toContain("report that the content could not be verified");
  });

  it("uses the available scraper even without search or Playwright", () => {
    const route = buildWebResearchRoutingInstruction(["mcp.scrapling.browser_fetch_once"]);
    expect(route).toContain("mcp.scrapling.browser_fetch_once");
    expect(route).toContain("When a URL is already supplied, skip searching");
    expect(route).not.toContain("mcp.searxng");
    expect(route).not.toContain("mcp.playwright");
    expect(route).not.toContain("mcp.scrapling.browser_screenshot");
  });

  it("supports environments with no MCP servers without claiming they are connected", () => {
    const route = buildWebResearchRoutingInstruction([]);
    expect(route).not.toContain("mcp.searxng.");
    expect(route).not.toContain("mcp.scrapling.");
    expect(route).not.toContain("mcp.playwright.");
    expect(route).toContain("last resort");
  });
});
