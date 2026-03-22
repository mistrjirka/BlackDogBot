import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";

import type {
  IMcpServerConfig,
  IMcpServersFile,
  IMcpServerEntry,
} from "../shared/types/mcp.types.js";
import { mcpServerConfigSchema } from "../shared/schemas/mcp.schemas.js";
import { LoggerService } from "./logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { getMcpServersFilePath } from "../utils/paths.js";

//#region Constants

const VALID_SERVER_ID_RE = /^[a-zA-Z0-9_-]+$/;

//#endregion Constants

//#region McpRegistryService

/**
 * Manages MCP server configuration stored in ~/.blackdogbot/mcp-servers.json.
 *
 * Format matches VS Code / Claude Desktop MCP config:
 * { "mcpServers": { "serverName": { "command": "...", "args": [...] } } }
 *
 * Used by McpService to connect to MCP servers and by Telegram commands
 * for dynamic server management.
 */
export class McpRegistryService {
  //#region Singleton

  private static _instance: McpRegistryService | null = null;

  public static getInstance(): McpRegistryService {
    if (!McpRegistryService._instance) {
      McpRegistryService._instance = new McpRegistryService();
    }
    return McpRegistryService._instance;
  }

  //#endregion Singleton

  //#region Data Members

  private _logger: LoggerService;
  private _servers: Map<string, IMcpServerEntry>;
  private _filePath: string;

  //#endregion Data Members

  //#region Constructor

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._servers = new Map();

    this._filePath = getMcpServersFilePath();
  }

  //#endregion Constructor

  //#region Public Methods - Lifecycle

  /**
   * Initialize the service by loading mcp-servers.json.
   * Must be called before using the service.
   */
  public async initializeAsync(): Promise<void> {
    await this._loadAsync();
  }

  //#endregion Public Methods - Lifecycle

  //#region Public Methods - Server Management

  /**
   * Add or update an MCP server entry.
   *
   * @param id Server key (used as namespace segment in tool names)
   * @param config VS Code / Claude Desktop format server config
   */
  public async addServerAsync(id: string, config: IMcpServerConfig): Promise<IMcpServerEntry> {
    if (!VALID_SERVER_ID_RE.test(id)) {
      throw new Error(
        `Invalid server id "${id}". Only alphanumeric, dash, and underscore characters are allowed.`,
      );
    }

    const validation = mcpServerConfigSchema.safeParse(config);

    if (!validation.success) {
      throw new Error(`Invalid MCP server config: ${validation.error.message}`);
    }

    const entry: IMcpServerEntry = {
      id,
      transport: config.command ? "stdio" : "http",
      config,
      enabled: true,
      strictOutputSchema: true,
    };

    this._servers.set(id, entry);
    await this._saveAsync();

    this._logger.info("Added/updated MCP server", {
      id,
      transport: entry.transport,
    });

    return entry;
  }

  /**
   * Remove an MCP server entry by id.
   *
   * @returns true if server was found and removed
   */
  public async removeServerAsync(id: string): Promise<boolean> {
    const existed = this._servers.delete(id);

    if (existed) {
      await this._saveAsync();
      this._logger.info("Removed MCP server", { id });
    }

    return existed;
  }

  /**
   * Enable or disable an MCP server without removing its config.
   */
  public async setEnabledAsync(id: string, enabled: boolean): Promise<boolean> {
    const entry = this._servers.get(id);

    if (!entry) {
      return false;
    }

    entry.enabled = enabled;
    await this._saveAsync();

    this._logger.info("Updated MCP server enabled state", { id, enabled });
    return true;
  }

  //#endregion Public Methods - Server Management

  //#region Public Methods - Queries

  /**
   * Get a specific server entry by id.
   */
  public getServer(id: string): IMcpServerEntry | undefined {
    return this._servers.get(id);
  }

  /**
   * Get all configured server entries.
   */
  public getAllServers(): IMcpServerEntry[] {
    return Array.from(this._servers.values());
  }

  /**
   * Check if a server exists.
   */
  public hasServer(id: string): boolean {
    return this._servers.has(id);
  }

  //#endregion Public Methods - Queries

  //#region Private Methods

  private async _loadAsync(): Promise<void> {
    try {
      if (existsSync(this._filePath)) {
        const content: string = await readFile(this._filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);

        if (
          parsed &&
          typeof parsed === "object" &&
          "mcpServers" in parsed &&
          typeof (parsed as IMcpServersFile).mcpServers === "object"
        ) {
          const file = parsed as IMcpServersFile;

          for (const [id, config] of Object.entries(file.mcpServers)) {
            this._servers.set(id, {
              id,
              transport: config.command ? "stdio" : "http",
              config,
              enabled: true,
              strictOutputSchema: true,
            });
          }

          this._logger.info("Loaded MCP servers from mcp-servers.json", {
            count: this._servers.size,
          });
        }
      }
    } catch (error) {
      this._logger.warn("Failed to load mcp-servers.json, starting fresh", {
        error: extractErrorMessage(error),
      });
      this._servers = new Map();
    }
  }

  private async _saveAsync(): Promise<void> {
    try {
      const dir = dirname(this._filePath);

      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const file: IMcpServersFile = {
        mcpServers: {},
      };

      for (const [id, entry] of this._servers) {
        file.mcpServers[id] = entry.config;
      }

      const content: string = JSON.stringify(file, null, 2);
      await writeFile(this._filePath, content, "utf-8");
    } catch (error) {
      this._logger.error("Failed to save mcp-servers.json", {
        error: extractErrorMessage(error),
      });
    }
  }

  //#endregion Private Methods
}

//#endregion McpRegistryService
