/**
 * Compact, capability-aware web research routing for the main agent.
 * This only describes tools that are actually connected on this turn;
 * MCP tool schemas remain the authoritative contract.
 */
export function buildWebResearchRoutingInstruction(toolNames: readonly string[]): string {
  const connected = new Set(toolNames);
  const hasSearch = connected.has("mcp.searxng.searxng_web_search");
  const hasScrapling = connected.has("mcp.scrapling.browser_fetch_once");
  const hasPlaywright = connected.has("mcp.playwright.browser_navigate");
  const hasScraplingScreenshot = connected.has("mcp.scrapling.browser_open")
    && connected.has("mcp.scrapling.browser_screenshot");

  const instructions: string[] = [
    "Web research tool priority (for ordinary source discovery and article reading):",
  ];

  if (hasSearch) {
    instructions.push(
      "1. DISCOVER: use mcp.searxng.searxng_web_search to find relevant source URLs. " +
      "When the user already provides a URL, skip search. Avoid repeated near-identical searches.",
    );
  } else {
    instructions.push(
      "1. DISCOVER: if necessary, use an available connected search tool for URLs. " +
      "When a URL is already supplied, skip searching.",
    );
  }

  if (hasScrapling) {
    instructions.push(
      "2. READ: open promising URLs with mcp.scrapling.browser_fetch_once; prefer extracted main-content " +
      "text/Markdown over navigation and raw HTML (use the tool's actual input schema). " +
      "Scrapling renders JavaScript, so do not jump to a full interactive browser merely because a page is dynamic. " +
      "Verify the returned article text, URL, and whether the result is a consent/CAPTCHA/error page. " +
      "HTTP 200 alone does not establish that the article was retrieved.",
    );
  } else {
    instructions.push(
      "2. READ: use an available extraction or page-reading MCP tool; verify that the requested article " +
      "content was actually returned, not just navigation, a snippet, or a consent page.",
    );
  }

  if (hasPlaywright) {
    instructions.push(
      "3. ESCALATE: use mcp.playwright browser tools when the user requests interaction (clicking, forms, " +
      "login, site navigation), or when scraping yields blocked, empty, partial or unusable content. " +
      "Do not use Playwright as the default for ordinary article text while Scrapling works.",
    );
  } else {
    instructions.push(
      "3. ESCALATE: for blocked or incomplete pages, try another available browser tool if connected; " +
      "otherwise report that the content could not be verified.",
    );
  }

  if (hasScraplingScreenshot) {
    instructions.push(
      "Scrapling vision: a text-only browser_fetch_once does not test image output. " +
      "For a requested screenshot, use mcp.scrapling.browser_open to establish a session, " +
      "mcp.scrapling.browser_screenshot to obtain an actual inline PNG image, then close_session. " +
      "Only claim screenshot/vision PASS when the screenshot tool was actually called and an image was received.",
    );
  }

  instructions.push(
    "Keep page extracts bounded; do not dump entire HTML, navigation boilerplate, or base64 images into context. " +
    "Cite actual source URLs and avoid claiming a complete article or visual analysis without supporting tool output. " +
    "If no suitable MCP tool is connected, run_cmd with curl/wget is a last resort.",
  );

  return instructions.join("\n");
}
