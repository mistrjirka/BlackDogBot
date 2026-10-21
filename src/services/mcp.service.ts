import { tool, type ToolSet } from "ai";
import type { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  IMcpServerEntry,
  IMcpServerToolsResult,
} from "../shared/types/mcp.types.js";
import { McpRegistryService } from "./mcp-registry.service.js";
import { LoggerService } from "./logger.service.js";
import { jsonSchemaToZod } from "../utils/json-schema-to-zod.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Types

/** Internal state for a connected MCP server */
interface IMcpServerConnection {
  client: Client;
  transport: Transport;
  tools: ToolSet;
  serverId: string;
}

//#endregion Types

//#region Constants

/** Delays before each reconnect retry during the initial connection attempt. */
const CONNECT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/**
 * Minimum time between on-demand reconnect attempts for a server that is
 * configured but not connected. Prevents every agent build from stalling on
 * the retry backoff while an MCP server is down.
 */
const RECONNECT_COOLDOWN_MS: number = 30_000;

//#endregion Constants

//#region McpService

/**
 * Manages MCP client connections and exposes MCP tools as AI SDK ToolSet.
 *
 * McpService connects to configured MCP servers, discovers their tools,
 * converts them to AI SDK tool format (with proper inputSchema/execute/toModelOutput),
 * and namespaces them as mcp.<serverId>.<toolName>.
 *
 * Used by MainAgent to merge MCP tools into its tool set.
 */
export class McpService {
  //#region Singleton

  private static _instance: McpService | null = null;

  public static getInstance(): McpService {
    if (!McpService._instance) {
      McpService._instance = new McpService();
    }
    return McpService._instance;
  }

  //#endregion Singleton

  //#region Data Members

  private _logger: LoggerService;
  private _registry: McpRegistryService;
  private _connections: Map<string, IMcpServerConnection>;
  private _combinedTools: ToolSet;
  private _serverResults: Map<string, IMcpServerToolsResult>;
  private _refreshPromise: Promise<void> | null;
  private _ensurePromise: Promise<void> | null;
  private _lastConnectAttemptAt: Map<string, number>;

  //#endregion Data Members

  //#region Constructor

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._registry = McpRegistryService.getInstance();
    this._connections = new Map();
    this._combinedTools = {};
    this._serverResults = new Map();
    this._refreshPromise = null;
    this._ensurePromise = null;
    this._lastConnectAttemptAt = new Map();
  }

  //#endregion Constructor

  //#region Public Methods

  /**
   * Connect to all enabled MCP servers and discover their tools.
   * Only reconnects servers whose config has changed or are new.
   * Existing connections with the same config are reused.
   */
  public async refreshAsync(): Promise<void> {
    if (this._refreshPromise) {
      this._logger.warn("MCP refresh already in progress, waiting for it to complete");
      return this._refreshPromise;
    }

    this._refreshPromise = this._doRefreshAsync();

    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  private async _doRefreshAsync(): Promise<void> {
    const registryServers = this._registry.getAllServers();
    const enabledIds = new Set<string>();

    // Phase 1: Close connections for removed or disabled servers
    for (const [id] of this._connections) {
      const entry = this._registry.getServer(id);

      if (!entry || !entry.enabled) {
        this._logger.info("Closing MCP server connection", {
          serverId: id,
          reason: !entry ? "removed" : "disabled",
        });
        await this._closeConnectionAsync(id);
      }
    }

    // Phase 2: Connect or reconnect enabled servers
    this._serverResults = new Map();

    for (const entry of registryServers) {
      if (!entry.enabled) {
        continue;
      }

      enabledIds.add(entry.id);

      // Check if already connected — reuse if config matches
      const existing = this._connections.get(entry.id);
      if (existing) {
        // Connection already exists, keep it
        const tools = this._collectToolsForServer(entry.id);
        this._serverResults.set(entry.id, {
          serverId: entry.id,
          loadedToolNames: tools,
          warnings: [],
          error: null,
        });
        continue;
      }

      // New or changed server — connect
      const result = await this._connectServerAsync(entry);
      this._serverResults.set(entry.id, result);
    }

    // Phase 3: Rebuild combined tool set from all active connections
    this._rebuildCombinedTools();

    this._logger.info("MCP service refreshed", {
      totalEnabled: enabledIds.size,
      connectedServers: this._connections.size,
      totalTools: Object.keys(this._combinedTools).length,
    });
  }

  /**
   * Get the combined ToolSet from all connected MCP servers.
   * Tool names are namespaced as mcp.<serverId>.<toolName>.
   */
  public getTools(): ToolSet {
    return { ...this._combinedTools };
  }

  /**
   * Reconnect enabled servers that are configured but not currently connected.
   *
   * This is an on-demand recovery path for transient failures (for example an
   * MCP container that was still starting when the process booted). Attempts
   * are throttled per server so an unavailable server does not add the retry
   * backoff to every agent build.
   */
  public async ensureConnectedAsync(): Promise<void> {
    if (this._refreshPromise) {
      await this._refreshPromise;
      return;
    }

    if (this._ensurePromise) {
      return this._ensurePromise;
    }

    this._ensurePromise = this._doEnsureConnectedAsync();

    try {
      await this._ensurePromise;
    } finally {
      this._ensurePromise = null;
    }
  }

  private async _doEnsureConnectedAsync(): Promise<void> {
    const now: number = Date.now();
    const pending: IMcpServerEntry[] = this._registry.getAllServers().filter(
      (entry: IMcpServerEntry): boolean => {
        if (!entry.enabled || this._connections.has(entry.id)) {
          return false;
        }

        const lastAttemptAt: number = this._lastConnectAttemptAt.get(entry.id) ?? 0;
        return now - lastAttemptAt >= RECONNECT_COOLDOWN_MS;
      },
    );

    if (pending.length === 0) {
      return;
    }

    for (const entry of pending) {
      const result: IMcpServerToolsResult = await this._connectServerAsync(entry);
      this._serverResults.set(entry.id, result);
    }

    this._rebuildCombinedTools();

    this._logger.info("MCP on-demand reconnect finished", {
      attempted: pending.map((entry: IMcpServerEntry): string => entry.id),
      connectedServers: this._connections.size,
      totalTools: Object.keys(this._combinedTools).length,
    });
  }

  /**
   * Get per-server discovery results (tool counts, warnings, errors).
   */
  public getServerResults(): Map<string, IMcpServerToolsResult> {
    const copy = new Map<string, IMcpServerToolsResult>();

    for (const [key, value] of this._serverResults) {
      copy.set(key, {
        serverId: value.serverId,
        loadedToolNames: [...value.loadedToolNames],
        warnings: [...value.warnings],
        error: value.error,
      });
    }

    return copy;
  }

  /**
   * Disconnect all MCP server clients and release resources.
   */
  public async closeAsync(): Promise<void> {
    const ids = Array.from(this._connections.keys());

    for (const id of ids) {
      await this._closeConnectionAsync(id);
    }

    this._combinedTools = {};
    this._serverResults = new Map();
    this._lastConnectAttemptAt.clear();
  }

  //#endregion Public Methods

  //#region Private Methods - Connection

  private async _connectServerAsync(entry: IMcpServerEntry): Promise<IMcpServerToolsResult> {
    this._lastConnectAttemptAt.set(entry.id, Date.now());

    const maxAttempts: number = CONNECT_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result: IMcpServerToolsResult = await this._connectServerOnceAsync(entry);

      if (!result.error) {
        return result;
      }

      if (attempt < maxAttempts) {
        const delayMs: number = CONNECT_RETRY_DELAYS_MS[attempt - 1];
        this._logger.warn("Retrying MCP server connection", {
          serverId: entry.id,
          attempt,
          maxAttempts,
          delayMs,
          error: result.error,
        });
        await new Promise<void>((resolve: () => void): void => {
          setTimeout(resolve, delayMs);
        });
        continue;
      }

      return result;
    }

    // Unreachable, but keeps the compiler satisfied.
    return {
      serverId: entry.id,
      loadedToolNames: [],
      warnings: [],
      error: "MCP connection attempts exhausted",
    };
  }

  private async _connectServerOnceAsync(entry: IMcpServerEntry): Promise<IMcpServerToolsResult> {
    const result: IMcpServerToolsResult = {
      serverId: entry.id,
      loadedToolNames: [],
      warnings: [],
      error: null,
    };

    let client: Client | null = null;
    let transport: Transport | null = null;

    try {
      transport = this._createTransport(entry);
      client = new Client({ name: "blackdogbot", version: "0.1.0" });

      await client.connect(transport);

      const { tools: mcpTools } = await client.listTools();
      const tools: ToolSet = {};

      const { kept, warnings } = filterMcpToolsForServer(entry, mcpTools);

      for (const warning of warnings) {
        result.warnings.push(warning);
        this._logger.warn(warning, { serverId: entry.id });
      }

      for (const mcpTool of kept) {
        const namespacedName = `mcp.${entry.id}.${mcpTool.name}`;
        const aiSdkTool = _convertMcpToolToAiSdk(client, mcpTool, entry.id);
        tools[namespacedName] = aiSdkTool;
        result.loadedToolNames.push(namespacedName);
      }

      // Only add to connections after full success (connect + listTools + convert)
      this._connections.set(entry.id, {
        client,
        transport,
        tools,
        serverId: entry.id,
      });

      this._logger.info("Connected to MCP server", {
        serverId: entry.id,
        transport: entry.transport,
        toolCount: result.loadedToolNames.length,
        skippedCount: result.warnings.length,
      });
    } catch (error) {
      result.error = extractErrorMessage(error);
      this._logger.error("Failed to connect to MCP server", {
        serverId: entry.id,
        error: result.error,
      });

      // Clean up partially created resources on failure
      if (client) {
        try {
          await client.close();
        } catch {
          // Best-effort cleanup
        }
      }
    }

    return result;
  }

  private _createTransport(entry: IMcpServerEntry): Transport {
    if (entry.transport === "stdio") {
      if (!entry.config.command) {
        throw new Error(`MCP server "${entry.id}" is missing its stdio command`);
      }

      const inheritedEnv: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry: [string, string | undefined]): entry is [string, string] => entry[1] !== undefined,
        ),
      );

      return new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args ?? [],
        env: { ...inheritedEnv, ...entry.config.env },
        stderr: "pipe",
      });
    }

    if (!entry.config.url) {
      throw new Error(`MCP server "${entry.id}" is missing its URL`);
    }

    const url = new URL(entry.config.url);
    const headers = entry.config.headers ?? {};

    // SSE transport for servers that only expose an SSE endpoint (e.g.
    // Crawl4AI at /mcp/sse). Configured headers are passed via requestInit:
    // the SDK merges them into both the initial SSE GET (via _commonHeaders)
    // and the follow-up MCP POSTs, so Authorization propagates on both legs.
    if (entry.transport === "sse") {
      return new SSEClientTransport(url, {
        requestInit: { headers },
      });
    }

    // Default HTTP transport using StreamableHTTP
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
  }

  private async _closeConnectionAsync(id: string): Promise<void> {
    const connection = this._connections.get(id);

    if (!connection) {
      return;
    }

    this._connections.delete(id);
    this._lastConnectAttemptAt.delete(id);

    try {
      // Add timeout to prevent hung servers from blocking shutdown
      const closePromise = connection.client.close();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      await Promise.race([closePromise, timeout]);
    } catch (error) {
      this._logger.warn("Error closing MCP server connection", {
        serverId: id,
        error: extractErrorMessage(error),
      });
    }
  }

  private _collectToolsForServer(serverId: string): string[] {
    const connection = this._connections.get(serverId);

    if (!connection) {
      return [];
    }

    return Object.keys(connection.tools);
  }

  private _rebuildCombinedTools(): void {
    this._combinedTools = {};

    for (const [, connection] of this._connections) {
      Object.assign(this._combinedTools, connection.tools);
    }
  }

  //#endregion Private Methods - Connection
}

//#endregion McpService

//#region Tool Filtering

/** Minimal shape of a discovered MCP tool needed for filtering decisions. */
export interface IMcpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * Decide which discovered MCP tools to expose for a server entry.
 *
 * Pure function (exported for focused unit tests). Rules, in order:
 * 1. When `allowedTools` is set, only listed server-side tool names are kept
 *    (least privilege — e.g. an allowlist of ["md", "crawl"]).
 * 2. When `strictOutputSchema` is true (the default), tools without
 *    outputSchema are skipped. When explicitly false, they load with an
 *    "unstructured results" warning (e.g. Crawl4AI tools define none).
 *
 * Strict mode is never relaxed globally — only per server via explicit config.
 */
export function filterMcpToolsForServer(
  entry: Pick<IMcpServerEntry, "strictOutputSchema" | "allowedTools">,
  mcpTools: IMcpDiscoveredTool[],
): { kept: IMcpDiscoveredTool[]; warnings: string[] } {
  const kept: IMcpDiscoveredTool[] = [];
  const warnings: string[] = [];

  for (const mcpTool of mcpTools) {
    if (entry.allowedTools && !entry.allowedTools.includes(mcpTool.name)) {
      warnings.push(`Skipped tool "${mcpTool.name}" — not in allowedTools allowlist`);
      continue;
    }

    if (entry.strictOutputSchema && !mcpTool.outputSchema) {
      warnings.push(`Skipped tool "${mcpTool.name}" — missing outputSchema (strict mode)`);
      continue;
    }

    if (!mcpTool.outputSchema) {
      warnings.push(`Tool "${mcpTool.name}" has no outputSchema — results may be unstructured`);
    }

    kept.push(mcpTool);
  }

  return { kept, warnings };
}

//#endregion Tool Filtering

//#region Private Functions

/**
 * Convert an MCP tool to an AI SDK tool with image output handling.
 * Uses `as any` because tool() overloads don't accept dynamic ZodType schemas.
 */
function _convertMcpToolToAiSdk(
  client: Client,
  mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> },
  serverId: string,
) {
  const description = mcpTool.description ?? `MCP tool: ${mcpTool.name} (server: ${serverId})`;
  const inputSchema = jsonSchemaToZod(mcpTool.inputSchema);
  const outputSchema = mcpTool.outputSchema;

  return tool({
    description,
    // MCP schemas are dynamic; jsonSchemaToZod returns a ZodType whose exact
    // generic cannot be inferred at this boundary.
    inputSchema: inputSchema as unknown as z.ZodTypeAny,
    execute: async (input: unknown) => {
      try {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          return {
            isError: true,
            content: [{ type: "text", text: "MCP tool input must be an object." }],
          };
        }

        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input as Record<string, unknown>,
        });
        return result;
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `MCP tool error: ${extractErrorMessage(error)}` }],
        };
      }
    },
    toModelOutput: ({ output }: { output: unknown }) => {
      return _convertMcpResultToModelOutput(output, outputSchema);
    },
  });
}

/**
 * Convert MCP callTool result to AI SDK model output format.
 *
 * Handles multimodal content:
 * - text → { type: "text", text }
 * - image → { type: "file-data", data, mediaType }
 * - audio → { type: "file-data", data, mediaType }
 */
function _convertMcpResultToModelOutput(
  output: unknown,
  outputSchema?: Record<string, unknown>,
) {
  if (!output || typeof output !== "object") {
    return {
      type: "content" as const,
      value: [{ type: "text" as const, text: JSON.stringify(output ?? null) }],
    };
  }

  const result = output as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(content)) {
    if (result.structuredContent && outputSchema) {
      return {
        type: "content" as const,
        value: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      };
    }

    return {
      type: "content" as const,
      value: [{ type: "text" as const, text: JSON.stringify(output) }],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP content items are dynamically typed (text/image/audio) - modelParts must accommodate all possible content types
  const modelParts: any[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object" || !("type" in item)) {
      continue;
    }

    switch (item.type) {
      case "text":
        modelParts.push({ type: "text", text: String(item.text ?? "") });
        break;

      case "image":
        modelParts.push({
          type: 'file-data',
          data: String(item.data ?? ""),
          mediaType: String(item.mimeType ?? "image/png"),
        });
        break;

      case "audio":
        modelParts.push({
          type: 'file-data',
          data: String(item.data ?? ""),
          mediaType: String(item.mimeType ?? "audio/mpeg"),
        });
        break;

      default:
        modelParts.push({
          type: "text",
          text: JSON.stringify(item),
        });
        break;
    }
  }

  if (result.structuredContent && typeof result.structuredContent === "object") {
    modelParts.push({
      type: "text",
      text: `\n\nStructured output:\n${JSON.stringify(result.structuredContent, null, 2)}`,
    });
  }

  if (modelParts.length === 0) {
    modelParts.push({ type: "text", text: "No content returned." });
  }

  return { type: "content" as const, value: modelParts };
}

//#endregion Private Functions
