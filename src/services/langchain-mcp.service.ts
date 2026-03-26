import { tool } from "langchain";
import type { DynamicStructuredTool } from "langchain";

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
  tools: DynamicStructuredTool[];
  serverId: string;
}

//#endregion Types

//#region LangchainMcpService

/**
 * Manages MCP client connections and exposes MCP tools as LangChain DynamicStructuredTool[].
 *
 * LangchainMcpService connects to configured MCP servers, discovers their tools,
 * converts them to LangChain tool format (with proper schema/execute),
 * and namespaces them as mcp.<serverId>.<toolName>.
 *
 * Used by MainAgent to merge MCP tools into its tool set.
 */
export class LangchainMcpService {
  //#region Singleton

  private static _instance: LangchainMcpService | null = null;

  public static getInstance(): LangchainMcpService {
    if (!LangchainMcpService._instance) {
      LangchainMcpService._instance = new LangchainMcpService();
    }
    return LangchainMcpService._instance;
  }

  //#endregion Singleton

  //#region Data Members

  private _logger: LoggerService;
  private _registry: McpRegistryService;
  private _connections: Map<string, IMcpServerConnection>;
  private _combinedTools: DynamicStructuredTool[];
  private _serverResults: Map<string, IMcpServerToolsResult>;
  private _refreshing: boolean;

  //#endregion Data Members

  //#region Constructor

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._registry = McpRegistryService.getInstance();
    this._connections = new Map();
    this._combinedTools = [];
    this._serverResults = new Map();
    this._refreshing = false;
  }

  //#endregion Constructor

  //#region Public Methods

  /**
   * Connect to all enabled MCP servers and discover their tools.
   * Only reconnects servers whose config has changed or are new.
   * Existing connections with the same config are reused.
   */
  public async refreshAsync(): Promise<void> {
    if (this._refreshing) {
      this._logger.warn("MCP refresh already in progress, skipping");
      return;
    }

    this._refreshing = true;

    try {
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
        totalTools: this._combinedTools.length,
      });
    } finally {
      this._refreshing = false;
    }
  }

  /**
   * Get the combined DynamicStructuredTool[] from all connected MCP servers.
   * Tool names are namespaced as mcp.<serverId>.<toolName>.
   */
  public getTools(): DynamicStructuredTool[] {
    return [...this._combinedTools];
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

    this._combinedTools = [];
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
      const tools: DynamicStructuredTool[] = [];

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
        const langchainTool = _convertMcpToolToLangchain(client, mcpTool, entry.id);
        tools.push(langchainTool);
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
        throw new Error(`MCP server "${entry.id}": stdio transport requires 'command' in config`);
      }
      return new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args ?? [],
        env: { ...process.env as Record<string, string>, ...entry.config.env },
        stderr: "pipe",
      });
    }

    // HTTP transport using StreamableHTTP (not deprecated SSE)
    if (!entry.config.url) {
      throw new Error(`MCP server "${entry.id}": http transport requires 'url' in config`);
    }
    const url = new URL(entry.config.url);
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

    return connection.tools.map((t) => t.name);
  }

  private _rebuildCombinedTools(): void {
    this._combinedTools = [];

    for (const [, connection] of this._connections) {
      this._combinedTools.push(...connection.tools);
    }
  }

  //#endregion Private Methods - Connection
}

//#endregion LangchainMcpService

//#region Private Functions

/**
 * Convert an MCP tool to a LangChain DynamicStructuredTool.
 */
function _convertMcpToolToLangchain(
  client: Client,
  mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> },
  serverId: string,
): DynamicStructuredTool {
  const description = mcpTool.description ?? `MCP tool: ${mcpTool.name} (server: ${serverId})`;
  const schema = jsonSchemaToZod(mcpTool.inputSchema);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tool(
    async (input: Record<string, unknown>) => {
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
    {
      name: `mcp.${serverId}.${mcpTool.name}`,
      description,
      schema,
    },
  ) as unknown as DynamicStructuredTool;
}

//#endregion Private Functions
