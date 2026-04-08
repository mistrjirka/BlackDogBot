import { tool, type ToolSet } from "ai";

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

  //#endregion Data Members

  //#region Constructor

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._registry = McpRegistryService.getInstance();
    this._connections = new Map();
    this._combinedTools = {};
    this._serverResults = new Map();
    this._refreshPromise = null;
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
  }

  //#endregion Public Methods

  //#region Private Methods - Connection

  private async _connectServerAsync(entry: IMcpServerEntry): Promise<IMcpServerToolsResult> {
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

      for (const mcpTool of mcpTools) {
        if (entry.strictOutputSchema && !mcpTool.outputSchema) {
          const warning = `Skipped tool "${mcpTool.name}" — missing outputSchema (strict mode)`;
          result.warnings.push(warning);
          this._logger.warn(warning, { serverId: entry.id, tool: mcpTool.name });
          continue;
        }

        if (!mcpTool.outputSchema) {
          const warning = `Tool "${mcpTool.name}" has no outputSchema — results may be unstructured`;
          result.warnings.push(warning);
          this._logger.warn(warning, { serverId: entry.id, tool: mcpTool.name });
        }

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
      return new StdioClientTransport({
        command: entry.config.command!,
        args: entry.config.args ?? [],
        env: { ...process.env as Record<string, string>, ...entry.config.env },
        stderr: "pipe",
      });
    }

    // HTTP transport using StreamableHTTP (not deprecated SSE)
    const url = new URL(entry.config.url!);
    const headers = entry.config.headers ?? {};

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP schema conversion produces a type incompatible with AI SDK's strict inputSchema type - dynamic tool definitions require flexible typing
  return tool({
    description,
    inputSchema: inputSchema as any,
    execute: async (input: unknown) => {
      try {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input as Record<string, string | number | boolean>,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- toModelOutput is an MCP-specific extension not in the standard AI SDK tool interface
  } as any);
}

/**
 * Convert MCP callTool result to AI SDK model output format.
 *
 * Handles multimodal content:
 * - text → { type: "text", text }
 * - image → { type: "media", data, mediaType }
 * - audio → { type: "media", data, mediaType }
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
          type: "media",
          data: String(item.data ?? ""),
          mediaType: String(item.mimeType ?? "image/png"),
        });
        break;

      case "audio":
        modelParts.push({
          type: "media",
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
