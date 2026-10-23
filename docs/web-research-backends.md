# Web research backends — agent selection and SearXNG MCP migration

Use the discovery-based MCP tools rather than adding provider-specific HTTP clients to BlackDogBot. The installed host uses SearXNG for search, Crawl4AI 0.9.4 for browser-based extraction, and Microsoft's Playwright MCP for actual navigation and interaction.

## SearXNG: MCP, not a core tool

Search is provided by [mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) version 2.7.0. Register an entry under `mcpServers` in `~/.blackdogbot/mcp-servers.json`:

```json
{
  "searxng": {
    "command": "npx",
    "args": ["-y", "mcp-searxng@2.7.0"],
    "env": { "SEARXNG_URL": "http://127.0.0.1:18731" },
    "strictOutputSchema": false,
    "allowedTools": [
      "searxng_web_search", "searxng_search_suggestions",
      "searxng_instance_info", "web_url_read"
    ]
  }
}
```

This is **one server entry**, not a replacement for the complete JSON file. The version is pinned; evaluate any newer version separately. The server advertises no output schemas, so strict filtering must be disabled only for that server, with the tool allowlist above. The dedicated built-in `searxng` HTTP client was removed. Old cron tasks naming `searxng` are resolved at runtime to the MCP `searxng_web_search` tool; new cron tasks should name `mcp.searxng.searxng_web_search` explicitly. The legacy `services.searxngUrl` config property is retained for configuration-file compatibility but is not used for search.

Live verification: connect via MCP stdio, list tools, call `searxng_instance_info` and `searxng_web_search` with a small query. An HTTP 200 is not sufficient: check source URLs and the search engine's unresponsive list. Actual upstream search engines may rate-limit or CAPTCHA self-hosted instances.

## Picking the lightest tool

1. **Known source, simple article:** use the MCP bounded `web_url_read` or Crawl4AI `md` result first. Request relevant sections; don't paste full page HTML into model context.
2. **Search/discovery:** use `mcp.searxng.searxng_web_search` with pagination, time range, categories, appropriate engine filters, and short queries. Treat snippets as leads, not verified evidence.
3. **JavaScript-rendered page with no interaction:** Crawl4AI `md` or `crawl` with suitable waiting selectors is typically sufficient. The 0.9.4 server successfully rendered `https://quotes.toscrape.com/js/` in both modes. Check the returned content, not just `success: true`.
4. **Clicking, login flows, menus, pagination, JS dialogs or web apps:** use Playwright MCP. Navigate, get an accessibility snapshot, interact using stable refs, and take screenshots only where visuals are needed. No separate autonomous browser agent is necessary: BlackDogBot itself decides the steps. Use isolated browser profiles for untrusted sites.
5. **Visually complex pages:** use Playwright's inline screenshot tool. The Crawl4AI 0.9.4 `screenshot` MCP tool returns its PNG as a large base64 string *inside a text JSON result*, not an MCP image block. Avoid sending that raw base64 through chat unless a proper image adapter is added.

## Alternatives to evaluate, not installed automatically

| Backend | Strengths | Costs / drawbacks |
|---|---|---|
| [Scrapling](https://scrapling.readthedocs.io/en/latest/ai/mcp-server.html) | MCP browser sessions, request and browser fetch, page actions, extraction and genuine screenshot image blocks | Python + browser dependency; should be benchmarked before replacing Crawl4AI |
| [Firecrawl](https://github.com/mendableai/firecrawl) | High-level scrape/crawl API, clean Markdown, MCP integration | Heavier self-hosted stack; some capabilities differ from hosted service |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Efficient snapshot-and-ref CLI, reusable skill, persistent browser sessions | Additional browser/daemon ecosystem; overlaps with existing Playwright MCP |
| [Browser Use](https://github.com/browser-use/browser-use) | Autonomous visual/browser agent for open-ended workflows | Duplicates the existing model's planning loop; model latency and context expense |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Already tested on the host, real browser, reliable accessibility refs and screenshots | Lower-level than scraper endpoints; use selectively |

Recommendation: keep the already-working Crawl4AI and Playwright while comparing Scrapling's one-shot fetch, JS rendering and multi-step browser operations on the same websites. Measure page completeness, elapsed time, success rate, tool-call count, memory use, and model input tokens. Choose a replacement only if measurements justify the operational overhead.

## Docker images, updates, and security

The running Crawl4AI image is version 0.9.4. A floating `latest` tag previously required manual intervention, so the Compose configuration is now pinned to `unclecode/crawl4ai:0.9.4`. Do not pull/recreate the container merely because the tag was pinned: the currently running image already matches the pinned tag. Back up the Compose file before any future update.

SearXNG currently publishes port `18731` on all host interfaces. Consider changing host-side mapping to `127.0.0.1:18731:8080` if LAN access isn't intentional; Docker recreation and health verification would be required for that network change. Make such a change separately from the MCP migration.

For container updates, pin target versions/digests, update one service at a time, and verify **functional** MCP calls as well as Docker health. Preserve previous images and configuration for rollback. An MCP registry update does not require replacing the search engine container.
