import { describe, expect, it } from "vitest";
import { buildWebResearchRoutingInstruction } from "../../src/agent/web-research-routing.js";

describe("web research tool routing", () => {
  const all = [
    "mcp.searxng.searxng_web_search", "mcp.searxng.web_url_read",
    "mcp.scrapling.browser_fetch_once", "mcp.scrapling.browser_open",
    "mcp.scrapling.browser_screenshot", "mcp.playwright.browser_navigate",
  ];

  it("routes search, extraction, browser escalation in that order", () => {
    const route = buildWebResearchRoutingInstruction(all);
    expect(route.indexOf("1. DISCOVER")).toBeLessThan(route.indexOf("2. READ"));
    expect(route.indexOf("2. READ")).toBeLessThan(route.indexOf("3. ESCALATE"));
    expect(route).toContain("mcp.searxng.searxng_web_search");
    expect(route).toContain("mcp.scrapling.browser_fetch_once");
    expect(route).toContain("mcp.playwright");
    expect(route).toContain("skip search");
    expect(route).toContain("HTTP 200 alone");
    expect(route).toContain("plain text or Markdown rather than HTML/DOM");
  });

  it("loads general research guidance when useful, without a mandatory verification checklist", () => {
    const route = buildWebResearchRoutingInstruction(all);
    expect(route).toContain("load web-research");
    expect(route).toContain("list_skills");
    expect(route).toContain("skip it for a trivial lookup");
    expect(route).not.toContain("verify_claim_evidence");
    expect(route).not.toContain("PS4");
  });

  it("keeps screenshot instructions tied to connected tools", () => {
    const route = buildWebResearchRoutingInstruction(all);
    expect(route).toContain("mcp.scrapling.browser_screenshot");
    expect(route).toContain("actual inline PNG image");
    expect(route).toContain("close_session");
  });

  it("does not advertise unavailable capabilities", () => {
    const route = buildWebResearchRoutingInstruction(["mcp.searxng.searxng_web_search"]);
    expect(route).toContain("mcp.searxng.searxng_web_search");
    expect(route).not.toContain("mcp.scrapling");
    expect(route).not.toContain("mcp.playwright");
    expect(route).toContain("could not be verified");
  });

  it("uses connected scraper without search or Playwright", () => {
    const route = buildWebResearchRoutingInstruction(["mcp.scrapling.browser_fetch_once"]);
    expect(route).toContain("mcp.scrapling.browser_fetch_once");
    expect(route).toContain("skip searching");
    expect(route).not.toContain("mcp.searxng");
  });

  it("uses a persistent stealth browser without repeatedly retrying challenges", () => {
    const route = buildWebResearchRoutingInstruction([
      "mcp.searxng.searxng_web_search", "mcp.searxng.web_url_read",
      "mcp.stealth.browser_open", "mcp.stealth.browser_navigate",
      "mcp.stealth.browser_read_text", "mcp.stealth.browser_take_screenshot",
    ]);
    expect(route).toContain("mcp.stealth.browser_open");
    expect(route).toContain("browser_read_text");
    expect(route).toContain("browser_close");
    expect(route).toContain("bot challenge");
    expect(route).not.toContain("mcp.scrapling");
  });

  it("works without connected web tools", () => {
    const route = buildWebResearchRoutingInstruction([]);
    expect(route).toContain("last resort");
    expect(route).not.toContain("mcp.searxng.");
    expect(route).not.toContain("mcp.scrapling.");
    expect(route).not.toContain("mcp.playwright.");
  });
});
