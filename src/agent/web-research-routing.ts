/** Connected-tool routing only. Evidence judgment belongs to the main prompt and optional skill. */
export function buildWebResearchRoutingInstruction(toolNames: readonly string[]): string {
  const connected = new Set(toolNames);
  const hasSearch = connected.has("mcp.searxng.searxng_web_search");
  const hasReader = connected.has("mcp.searxng.web_url_read");
  const hasScrapling = connected.has("mcp.scrapling.browser_fetch_once");
  const hasPlaywright = connected.has("mcp.playwright.browser_navigate");
  const hasStealth = connected.has("mcp.stealth.browser_open")
    && connected.has("mcp.stealth.browser_navigate")
    && connected.has("mcp.stealth.browser_read_text");
  const hasStealthScreenshot = connected.has("mcp.stealth.browser_take_screenshot");
  const hasScraplingScreenshot = connected.has("mcp.scrapling.browser_open")
    && connected.has("mcp.scrapling.browser_screenshot");

  const instructions: string[] = [
    "Web research tool priority (only connected tools are available):",
    "For substantive, disputed, or version-dependent factual research, load web-research using list_skills and load_skill; skip it for a trivial lookup.",
    hasSearch
      ? "1. DISCOVER: use mcp.searxng.searxng_web_search for source URLs. If the user supplied a URL, skip search. Avoid redundant searches."
      : "1. DISCOVER: use an available search tool if needed. When a URL is already supplied, skip searching.",
  ];

  if (hasScrapling) {
    instructions.push(
      "2. READ: use mcp.scrapling.browser_fetch_once for article content. It handles many JavaScript pages, so do not jump to a full interactive browser by default.",
    );
  } else if (hasReader) {
    instructions.push(
      "2. READ: use mcp.searxng.web_url_read for ordinary pages. If blocked or JavaScript-rendered, try a different source or the connected browser.",
    );
  } else {
    instructions.push("2. READ: use available page-extraction tools; verify that they returned the requested content.");
  }

  if (hasStealth) {
    instructions.push(
      "3. ESCALATE: for blocked/dynamic pages use mcp.stealth.browser_open, browser_navigate, then browser_read_text; browser_close afterward. A failed browser_open means no session exists. A CAPTCHA/Cloudflare page is not the article.",
    );
  } else if (hasPlaywright) {
    instructions.push(
      "3. ESCALATE: use mcp.playwright when interaction is required or simpler extraction fails. Do not use Playwright as the default for article reading.",
    );
  } else {
    instructions.push("3. ESCALATE: if content remains blocked or incomplete and no browser is connected, report that it could not be verified.");
  }

  if (hasStealthScreenshot) {
    instructions.push("For screenshots, use mcp.stealth.browser_take_screenshot in an open session, verify a real image, then browser_close.");
  } else if (hasScraplingScreenshot) {
    instructions.push("For screenshots, use mcp.scrapling.browser_open and mcp.scrapling.browser_screenshot; check for an actual inline PNG image, then close_session. Do not infer image content from extracted text.");
  }

  instructions.push(
    "MCP page tools may return extracted plain text or Markdown rather than HTML/DOM. Inspect the actual format before parsing: do not search for HTML elements in plain text. For long content, filter saved blackboard values with run_code/inspect_variable.",
    "If repeated attempts encounter the same bot challenge, stop retrying that route. HTTP 200 alone does not guarantee readable content. Prefer another source or a working browser over repeated shell curl requests; run_cmd with curl/wget is a last resort. Keep extracts short and source attribution clear.",
  );
  return instructions.join("\n");
}
