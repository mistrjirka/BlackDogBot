# Playwright MCP: browser and screenshot setup

Prefer the official Microsoft Playwright MCP server: `@playwright/mcp`. Inspect its current documentation/package version before installing. Use the existing BlackDogBot Playwright config as a tested reference; do not reinstall an existing working server. The repository also documents setup in `docs/mcp-playwright.md` (read it with ordinary file tools if available).

## Tested local configuration

For a headless isolated Firefox browser, a tested entry is:

```json
{
  "command": "npx",
  "args": [
    "-y", "@playwright/mcp@0.0.83",
    "--browser", "firefox",
    "--headless", "--isolated", "--caps", "vision",
    "--output-dir", "/home/jirka/.blackdogbot/playwright-artifacts"
  ],
  "strictOutputSchema": false,
  "allowedTools": [
    "browser_navigate", "browser_navigate_back", "browser_snapshot",
    "browser_take_screenshot", "browser_click", "browser_type",
    "browser_press_key", "browser_fill_form", "browser_wait_for",
    "browser_tabs", "browser_resize", "browser_select_option",
    "browser_console_messages", "browser_network_requests", "browser_close"
  ]
}
```

This is **one server entry** under the name `playwright`, not a complete replacement for `mcp-servers.json`. Adapt the output directory for the current user's home. The pinned example version is a *known tested version*, not a claim that it is the latest release. Confirm flags from `npx -y @playwright/mcp@0.0.83 --help` before use.

Install the Firefox revision required by the matching Playwright runtime (use its CLI and documented install instructions). Browser dependencies may already exist. Prefer an unprivileged user-local install and do not `sudo` blindly. If OS packages truly require elevated privileges, report the blocker instead of circumventing it.

Playwright tools on the tested server have no `outputSchema`, which is why the exception `strictOutputSchema: false` is needed. Keep a reasonably narrow `allowedTools` list, avoiding `browser_run_code` and other unrestricted code execution unless explicitly needed.

## Live verification

1. Start the actual MCP server through stdio and use an MCP SDK client to call `initialize`/connect and `listTools`. Verify `browser_navigate` and `browser_take_screenshot` are present.
2. Navigate to `https://example.com` and call `browser_take_screenshot` with `{"type":"png"}`. The `scale` property accepts `"css"` or `"device"`, not `"1"`.
3. Verify the result includes an MCP `image` content item with `mimeType: "image/png"` and nonempty `data`. Do not log the full base64.
4. After registry reload on the next turn, verify namespaced tools `mcp.playwright.browser_navigate` and `mcp.playwright.browser_take_screenshot`. With a vision-capable model, ask the model to report visually observed layout, rather than just page text.
5. Successful screenshot capture and successful visual analysis are **separate tests**. If vision is unavailable, report capture PASS and interpretation NOT TESTED; do not invent visual details.

See [references/configuration.md](configuration.md) for safe registry edits, reconnection, and rollback.
