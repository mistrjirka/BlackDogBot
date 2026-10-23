import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { McpRegistryService } from "../../src/services/mcp-registry.service.js";
import { McpService, filterMcpToolsForServer } from "../../src/services/mcp.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import type { IMcpServerEntry } from "../../src/shared/types/mcp.types.js";
import { CRON_VALID_TOOL_NAMES } from "../../src/shared/schemas/tool-schemas.js";
import { CRON_TOOL_DESCRIPTIONS } from "../../src/shared/constants/cron-descriptions.js";
import { filterInvalidTools } from "../../src/utils/cron-tool-validation.js";
import { isToolAllowed } from "../../src/helpers/tool-registry.js";
import { resetSingletons, silenceLogger } from "../utils/test-helpers.js";

/**
 * CODE-SIDE Crawl4AI MCP migration:
 * - explicit `transport: "sse"` with Authorization header propagation,
 * - per-server strictOutputSchema opt-out (default stays true),
 * - per-server allowedTools allowlist (md/crawl in, execute_js out),
 * - prompt/policy/validation references to the namespaced tools.
 */

let tempDir: string;
let originalHome: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-mcp-crawl4ai-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  resetSingletons([McpRegistryService, McpService, LoggerService]);
  silenceLogger(LoggerService.getInstance());
});

afterEach(async () => {
  resetSingletons([McpRegistryService, McpService, LoggerService]);
  vi.restoreAllMocks();

  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
});

//#region Helpers

function _strictEntry(overrides?: Partial<IMcpServerEntry>): IMcpServerEntry {
  return {
    id: "test",
    transport: "http",
    config: { url: "https://mcp.example.com/mcp" },
    enabled: true,
    strictOutputSchema: true,
    ...overrides,
  };
}

function _noSchemaTool(name: string) {
  return { name, inputSchema: { type: "object" } as Record<string, unknown> };
}

function _schemaTool(name: string) {
  return {
    name,
    inputSchema: { type: "object" } as Record<string, unknown>,
    outputSchema: { type: "object" } as Record<string, unknown>,
  };
}

//#endregion Helpers

describe("MCP registry SSE/strict/allowlist settings", () => {
  it("derives sse transport from explicit config.transport", async () => {
    const registry = McpRegistryService.getInstance();
    await registry.initializeAsync();

    const entry = await registry.addServerAsync("crawl4ai", {
      url: "http://localhost:11235/mcp/sse",
      transport: "sse",
      headers: { Authorization: "Bearer secret" },
      strictOutputSchema: false,
      allowedTools: ["md", "crawl"],
    });

    expect(entry.transport).toBe("sse");
    expect(entry.strictOutputSchema).toBe(false);
    expect(entry.allowedTools).toEqual(["md", "crawl"]);
  });

  it("defaults remote servers to http transport and strict mode", async () => {
    const registry = McpRegistryService.getInstance();
    await registry.initializeAsync();

    const entry = await registry.addServerAsync("other", {
      url: "https://mcp.example.com/mcp",
    });

    expect(entry.transport).toBe("http");
    expect(entry.strictOutputSchema).toBe(true);
    expect(entry.allowedTools).toBeUndefined();
  });

  it("persists and reloads sse/strict/allowlist settings", async () => {
    const registry = McpRegistryService.getInstance();
    await registry.initializeAsync();

    await registry.addServerAsync("crawl4ai", {
      url: "http://localhost:11235/mcp/sse",
      transport: "sse",
      headers: { Authorization: "Bearer secret" },
      strictOutputSchema: false,
      allowedTools: ["md", "crawl"],
    });

    const filePath = path.join(tempDir, ".blackdogbot", "mcp-servers.json");
    const persisted = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(persisted.mcpServers["crawl4ai"].transport).toBe("sse");
    expect(persisted.mcpServers["crawl4ai"].strictOutputSchema).toBe(false);
    expect(persisted.mcpServers["crawl4ai"].allowedTools).toEqual(["md", "crawl"]);
    expect(persisted.mcpServers["crawl4ai"].headers).toEqual({ Authorization: "Bearer secret" });

    resetSingletons([McpRegistryService]);
    silenceLogger(LoggerService.getInstance());
    const reloaded = McpRegistryService.getInstance();
    await reloaded.initializeAsync();

    const entry = reloaded.getServer("crawl4ai");
    expect(entry?.transport).toBe("sse");
    expect(entry?.strictOutputSchema).toBe(false);
    expect(entry?.allowedTools).toEqual(["md", "crawl"]);
  });
});

describe("SSE transport creation with header propagation", () => {
  it("creates SSEClientTransport with configured headers for sse entries", () => {
    const service = McpService.getInstance();
    const createTransport = (service as unknown as {
      _createTransport: (entry: IMcpServerEntry) => unknown;
    })._createTransport.bind(service);

    const entry = _strictEntry({
      id: "crawl4ai",
      transport: "sse",
      config: {
        url: "http://localhost:11235/mcp/sse",
        headers: { Authorization: "Bearer secret" },
      },
    });

    const transport = createTransport(entry);
    expect(transport).toBeInstanceOf(SSEClientTransport);

    // The SDK merges requestInit.headers into BOTH the initial SSE GET
    // (via _commonHeaders in the EventSource fetch wrapper) and the MCP POSTs.
    const requestInit = (transport as unknown as { _requestInit?: RequestInit })._requestInit;
    expect(requestInit?.headers).toEqual({ Authorization: "Bearer secret" });
  });

  it("creates StreamableHTTPClientTransport for default http entries", () => {
    const service = McpService.getInstance();
    const createTransport = (service as unknown as {
      _createTransport: (entry: IMcpServerEntry) => unknown;
    })._createTransport.bind(service);

    const entry = _strictEntry({
      config: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer token" },
      },
    });

    const transport = createTransport(entry);
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(transport).not.toBeInstanceOf(SSEClientTransport);

    const requestInit = (transport as unknown as { _requestInit?: RequestInit })._requestInit;
    expect(requestInit?.headers).toEqual({ Authorization: "Bearer token" });
  });
});

describe("filterMcpToolsForServer", () => {
  it("skips tools without outputSchema when strict (default)", () => {
    const { kept, warnings } = filterMcpToolsForServer(_strictEntry(), [
      _noSchemaTool("md"),
      _schemaTool("ok"),
    ]);

    expect(kept.map((t) => t.name)).toEqual(["ok"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Skipped tool "md"');
    expect(warnings[0]).toContain("strict mode");
  });

  it("exposes every discovered tool without outputSchema when strict is opted out and no allowlist is set", () => {
    const discoveredNames = ["md", "html", "screenshot", "pdf", "execute_js", "crawl", "ask"];
    const { kept, warnings } = filterMcpToolsForServer(
      _strictEntry({ id: "crawl4ai", strictOutputSchema: false }),
      discoveredNames.map(_noSchemaTool),
    );

    expect(kept.map((tool) => tool.name)).toEqual(discoveredNames);
    expect(warnings).toHaveLength(discoveredNames.length);
    expect(warnings[0]).toContain("results may be unstructured");
  });

  it("allowlist exposes only md/crawl and excludes execute_js", () => {
    const { kept, warnings } = filterMcpToolsForServer(
      _strictEntry({
        id: "crawl4ai",
        strictOutputSchema: false,
        allowedTools: ["md", "crawl"],
      }),
      [
        _noSchemaTool("md"),
        _noSchemaTool("html"),
        _noSchemaTool("screenshot"),
        _noSchemaTool("pdf"),
        _noSchemaTool("execute_js"),
        _noSchemaTool("crawl"),
        _noSchemaTool("ask"),
      ],
    );

    expect(kept.map((t) => t.name)).toEqual(["md", "crawl"]);
    expect(kept.map((t) => t.name)).not.toContain("execute_js");
    expect(warnings.some((w) => w.includes('"execute_js"') && w.includes("allowlist"))).toBe(true);
  });

  it("keeps strict behavior for non-allowlisted servers (no global relaxation)", () => {
    const { kept } = filterMcpToolsForServer(_strictEntry(), [_noSchemaTool("md")]);
    expect(kept).toEqual([]);
  });
});

describe("read-only policy after Crawl4AI retirement", () => {
  it("allows only the known safe one-shot Scrapling fetch in read_only mode", () => {
    expect(isToolAllowed("mcp.scrapling.browser_fetch_once", "read_only")).toBe(true);
    for (const name of ["browser_open", "browser_actions", "browser_screenshot"]) {
      expect(isToolAllowed(`mcp.scrapling.${name}`, "read_only")).toBe(false);
    }
    expect(isToolAllowed("mcp.crawl4ai.md", "read_only")).toBe(false);
  });

  it("blocks page-script execution and unrelated MCP tools in read_only mode", () => {
    expect(isToolAllowed("mcp.crawl4ai.execute_js", "read_only")).toBe(false);
    expect(isToolAllowed("mcp.other.md", "read_only")).toBe(false);
  });

  it("allows all discovered Crawl4AI tools in full mode", () => {
    for (const name of ["md", "html", "screenshot", "pdf", "execute_js", "crawl", "ask"]) {
      expect(isToolAllowed(`mcp.crawl4ai.${name}`, "full")).toBe(true);
    }
  });
});

describe("cron validation migrates away from retired MCP servers", () => {
  it("does not keep retired Crawl4AI tools in the static cron list", () => {
    expect(CRON_VALID_TOOL_NAMES.some((name) => name.startsWith("mcp.crawl4ai."))).toBe(false);
    expect(CRON_VALID_TOOL_NAMES.some((name) => name.startsWith("mcp.scrapling."))).toBe(false);
  });

  it("rejects unconnected retired MCP tools rather than silently advertising them", () => {
    vi.spyOn(McpService.getInstance(), "getTools").mockReturnValue({
      "mcp.scrapling.browser_fetch_once": { description: "Fetch a webpage" },
    } as never);
    expect(filterInvalidTools(["mcp.scrapling.browser_fetch_once", "send_message"])).toEqual([]);
    expect(filterInvalidTools(["mcp.crawl4ai.md", "mcp.crawl4ai.crawl"])).toEqual([
      "mcp.crawl4ai.md", "mcp.crawl4ai.crawl",
    ]);
  });

  it("does not inject old Crawl4AI descriptions into cron task verification", () => {
    expect(Object.keys(CRON_TOOL_DESCRIPTIONS).some((name) => name.startsWith("mcp.crawl4ai."))).toBe(false);
  });
});
