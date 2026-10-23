import { writeFile, readFile, mkdir, rename, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";

import type {
  IMcpServerConfig,
  IMcpServersFile,
  IMcpServerEntry,
} from "../shared/types/mcp.types.js";
import { mcpServerConfigSchema, mcpServersFileSchema } from "../shared/schemas/mcp.schemas.js";
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

  /**
   * Re-read the registry after external edits (e.g. an agent using run_cmd).
   * Reject invalid files without disrupting currently connected servers.
   * Returns true only when effective validated server configurations changed.
   */
  public async reloadIfChangedAsync(): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this._filePath, "utf-8");
    } catch (error: unknown) {
      this._logger.warn("Cannot reload MCP configuration; preserving working registry", {
        error: extractErrorMessage(error),
      });
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this._logger.warn("MCP configuration has invalid JSON; preserving working registry");
      return false;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !("mcpServers" in parsed) || !(parsed as { mcpServers?: unknown }).mcpServers ||
        typeof (parsed as { mcpServers: unknown }).mcpServers !== "object" ||
        Array.isArray((parsed as { mcpServers: unknown }).mcpServers)) {
      this._logger.warn("MCP configuration is missing mcpServers; preserving working registry");
      return false;
    }

    const next = new Map<string, IMcpServerEntry>();
    const configs = (parsed as IMcpServersFile).mcpServers;
    for (const [id, config] of Object.entries(configs)) {
      if (!VALID_SERVER_ID_RE.test(id)) {
        this._logger.warn("MCP configuration contains an invalid server id; preserving working registry", { id });
        return false;
      }
      const validation = mcpServerConfigSchema.safeParse(config);
      if (!validation.success) {
        this._logger.warn("Invalid MCP server entry; preserving working registry", {
          id, error: validation.error.message,
        });
        return false;
      }
      next.set(id, _entryFromConfig(id, validation.data));
    }

    const currentSignature = JSON.stringify(
      [...this._servers].map(([id, entry]) => [id, entry.config]),
    );
    const nextSignature = JSON.stringify(
      [...next].map(([id, entry]) => [id, entry.config]),
    );
    if (currentSignature === nextSignature) return false;

    this._servers = next;
    this._logger.info("Externally edited MCP configuration reloaded", { serverCount: next.size });
    return true;
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
    await this._assertConfigurationWritableAsync();
    if (!VALID_SERVER_ID_RE.test(id)) {
      throw new Error(
        `Invalid server id "${id}". Only alphanumeric, dash, and underscore characters are allowed.`,
      );
    }

    const validation = mcpServerConfigSchema.safeParse(config);

    if (!validation.success) {
      throw new Error(`Invalid MCP server config: ${validation.error.message}`);
    }

    const entry: IMcpServerEntry = _entryFromConfig(id, validation.data);

    await this.reloadIfChangedAsync();
    const previous = this._servers.get(id);
    this._servers.set(id, entry);
    try {
      await this._saveAsync();
    } catch (error) {
      if (previous) this._servers.set(id, previous);
      else this._servers.delete(id);
      throw error;
    }

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
    await this._assertConfigurationWritableAsync();
    await this.reloadIfChangedAsync();
    const previous = this._servers.get(id);
    const existed = this._servers.delete(id);

    if (existed) {
      try { await this._saveAsync(); }
      catch (error) {
        if (previous) this._servers.set(id, previous);
        throw error;
      }
      this._logger.info("Removed MCP server", { id });
    }

    return existed;
  }

  /**
   * Enable or disable an MCP server without removing its config.
   */
  public async setEnabledAsync(id: string, enabled: boolean): Promise<boolean> {
    await this._assertConfigurationWritableAsync();
    await this.reloadIfChangedAsync();
    const entry = this._servers.get(id);

    if (!entry) return false;

    const old = entry.enabled;
    entry.enabled = enabled;
    try { await this._saveAsync(); }
    catch (error) { entry.enabled = old; throw error; }

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

          for (const [id, rawConfig] of Object.entries(file.mcpServers)) {
            const validation = mcpServerConfigSchema.safeParse(rawConfig);
            if (!validation.success) {
              this._logger.warn("Skipping invalid MCP server config", {
                serverId: id,
                error: validation.error.message,
              });
              continue;
            }

            this._servers.set(id, _entryFromConfig(id, validation.data));
          }

          this._logger.info("Loaded MCP servers from mcp-servers.json", {
            count: this._servers.size,
          });
        }
      }
    } catch (error) {
      const errorDetails: string = extractErrorMessage(error);
      this._logger.error(
        "Failed to parse mcp-servers.json - configuration is corrupted. Starting fresh. " +
          "Please fix the JSON syntax in your config file.",
        { error: errorDetails },
      );
      this._servers = new Map();
    }
  }

  private async _assertConfigurationWritableAsync(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this._filePath, "utf-8");
    } catch (error) {
      if (typeof error === "object" && error && "code" in error &&
          (error as { code: unknown }).code === "ENOENT") return;
      throw error;
    }
    try {
      const file = mcpServersFileSchema.parse(JSON.parse(content));
      if (Object.keys(file.mcpServers).some(id => !VALID_SERVER_ID_RE.test(id))) {
        throw new Error("Invalid server identifier");
      }
    } catch {
      throw new Error("Refusing to overwrite invalid MCP registry; repair or restore its JSON first.");
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
      const tempPath = this._filePath + ".tmp-" + process.pid + "-" + Date.now();
      try {
        await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
        await rename(tempPath, this._filePath);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      this._logger.error("Failed to save mcp-servers.json", {
        error: extractErrorMessage(error),
      });
      throw error;
    }
  }

  //#endregion Private Methods
}

//#endregion McpRegistryService

//#region Private Functions

/**
 * Build a runtime entry from a stored/validated server config.
 * Transport honors an explicit remote selector ("sse" for SSE-only servers
 * such as Crawl4AI); strict mode defaults to true; the tool allowlist is
 * carried through when present. The full config (including these custom
 * settings) is what _saveAsync persists, so they round-trip through the file.
 */
function _entryFromConfig(id: string, config: IMcpServerConfig): IMcpServerEntry {
  return {
    id,
    transport: config.command ? "stdio" : (config.transport ?? "http"),
    config,
    enabled: true,
    strictOutputSchema: config.strictOutputSchema ?? true,
    allowedTools: config.allowedTools,
  };
}

//#endregion Private Functions
