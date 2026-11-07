#!/usr/bin/env node
// Verify that configured MCP servers negotiate the protocol and expose tools.
// This intentionally does not rely on HTTP 200 or a successful npm install alone.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const file = process.env.BLACKDOGBOT_MCP_CONFIG_FILE ?? join(homedir(), ".blackdogbot", "mcp-servers.json");
const skip = new Set((process.env.BLACKDOGBOT_MCP_VERIFY_SKIP ?? "").split(",").filter(Boolean));
let failed = false;

function transportFor(config) {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env },
      stderr: "pipe",
    });
  }
  if (!config.url) throw Error("Missing MCP command or URL");
  const url = new URL(config.url);
  const requestInit = { headers: config.headers ?? {} };
  return config.transport === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

const { mcpServers } = JSON.parse(await readFile(file, "utf8"));
for (const [id, config] of Object.entries(mcpServers)) {
  if (skip.has(id)) {
    console.log("SKIP", id, "Docker service was not started");
    continue;
  }
  const client = new Client({ name: "blackdogbot-install-check", version: "0.1.0" });
  try {
    await client.connect(transportFor(config));
    const discovered = (await client.listTools()).tools;
    const actualNames = new Set(discovered.map(tool => tool.name));
    const missing = (config.allowedTools ?? []).filter(name => !actualNames.has(name));
    if (missing.length) throw Error("Missing configured MCP tools: " + missing.join(", "));
    const usable = discovered.filter(tool =>
      (!config.allowedTools || config.allowedTools.includes(tool.name)) &&
      (config.strictOutputSchema === false || tool.outputSchema)
    );
    if (usable.length === 0) throw Error("No usable MCP tools after allowlist/schema filtering");

    if (id === "searxng" && actualNames.has("searxng_instance_info")) {
      const info = await client.callTool({ name: "searxng_instance_info", arguments: {} });
      if (info.isError) throw Error("SearXNG instance information check failed");
    }
    if (id === "scrapling" && actualNames.has("list_sessions")) {
      const sessions = await client.callTool({ name: "list_sessions", arguments: {} });
      if (sessions.isError) throw Error("Scrapling session list check failed");
    }

    // Verify the browser is actually runnable, not merely installed.
    if (id === "playwright") {
      const navigation = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
      if (navigation.isError) throw Error("Playwright failed to launch the browser");
      const screenshot = await client.callTool({ name: "browser_take_screenshot", arguments: { type: "png" } });
      if (screenshot.isError || !screenshot.content?.some(part => part.type === "image" && part.data?.length > 100)) {
        throw Error("Playwright failed to capture an image");
      }
    }
    console.log("PASS", id, "discovered", discovered.length, "usable", usable.length, "tools");
  } catch (error) {
    failed = true;
    console.error("FAIL", id, String(error?.message ?? error));
  } finally {
    await client.close().catch(() => {});
  }
}
if (failed) process.exitCode = 1;
