# Playwright MCP for BlackDogBot

A fresh installation offers Playwright MCP automatically. It installs the pinned `@playwright/mcp@0.0.84` under `~/.local/share/blackdogbot/mcp/playwright` and downloads Firefox with the **exact Playwright version included in that MCP package**. This supports Linux x86-64 and arm64 without a Chrome dependency.

To install only the Playwright runtime from a Git checkout:

```bash
bash scripts/install-mcp-runtime.sh playwright
```

The installer adds the following **entry** to `~/.blackdogbot/mcp-servers.json`. For manual setup, replace `YOUR_USER` with the actual home-directory name. The shown paths must be absolute.

```json
{
  "playwright": {
    "command": "/home/YOUR_USER/.local/share/blackdogbot/mcp/playwright/node_modules/.bin/playwright-mcp",
    "env": {
      "PLAYWRIGHT_BROWSERS_PATH": "/home/YOUR_USER/.local/share/blackdogbot/mcp/playwright/browsers"
    },
    "args": [
      "--browser", "firefox",
      "--headless", "--isolated", "--caps", "vision",
      "--output-dir", "/home/YOUR_USER/.blackdogbot/playwright-artifacts"
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

Do not replace the whole MCP registry with this single entry. The installer preserves existing servers and uses private file permissions. When adding an MCP entry to a running bot, the registry reloads on the next chat turn.

The exception `strictOutputSchema: false` is local to Playwright because its tools do not advertise an output schema. The allowlist excludes unrestricted browser code execution.

## Verification

The installer runs `scripts/verify-mcp-install.mjs`. It connects through MCP, checks the tool list, opens `about:blank`, and verifies a screenshot containing an actual `image/png` content part. This checks the browser runtime, not just the npm package.

For an external test, ask the bot to navigate to `https://example.com`, take a screenshot, and describe it with a vision-capable model.
