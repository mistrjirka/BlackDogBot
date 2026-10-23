# Playwright MCP for BlackDogBot

BlackDogBot supports Playwright through its standard MCP registry. To receive screenshots as images, use a vision-capable model and enable Playwright's vision capability.

Add an entry under `mcpServers` in `~/.blackdogbot/mcp-servers.json`:

```json
{
  "playwright": {
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
}
```

The sample is an **entry**, not a replacement for the whole existing configuration. Adjust the absolute screenshot directory to your home directory. Install Firefox for the matching Playwright runtime first (e.g. `npx -y playwright@1.64.1 install firefox`; ensure the browser version matches the MCP package's runtime if pinning versions). Restart the BlackDogBot service to refresh MCP tools.

**Why `strictOutputSchema: false`?** Playwright MCP currently advertises no `outputSchema` for its tools. Strict discovery would silently hide every Playwright tool. This exception is restricted to the Playwright server, not global MCP policy.

**Screenshots:** `browser_take_screenshot` returns both a local artifact path and a base64 `image/png` MCP content part. BlackDogBot converts image parts to AI SDK `file` model-output parts. The screenshot does **not** need to be reopened with `read_image`, and the image itself is not text.

**Verification:** Ask Nate to navigate to `https://example.com`, take a screenshot, and describe what is visible. Verify `mcp.playwright.browser_take_screenshot` appears in the connected tool set. The browser is headless, uses a non-persistent profile, and saves artifacts outside the repository.
