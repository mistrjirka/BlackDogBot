/** VS Code / Claude Desktop format for a single MCP server entry */
export interface IMcpServerConfig {
  /** For stdio transport: command to spawn */
  command?: string;
  /** Command arguments (stdio only) */
  args?: string[];
  /** Extra environment variables (stdio only) */
  env?: Record<string, string>;
  /** For http/sse transport: server URL */
  url?: string;
  /** HTTP headers (http/sse only) */
  headers?: Record<string, string>;
  /** Explicit remote transport selector. "sse" uses SSEClientTransport
   * (required by servers that only expose /mcp/sse, e.g. Crawl4AI);
   * "http" (default) uses StreamableHTTPClientTransport. */
  transport?: "sse" | "http";
  /** Per-server strict-output override. Defaults to true (skip tools without
   * outputSchema). Set false only for servers whose tools legitimately omit
   * outputSchema (e.g. Crawl4AI: md, crawl, ... have none). */
  strictOutputSchema?: boolean;
  /** Optional allowlist of server-side tool names to expose. When set, only
   * listed tools are registered (least privilege, e.g. ["md", "crawl"]).
   * When omitted, all discovered tools are exposed (subject to strict mode). */
  allowedTools?: string[];
}

/** Top-level config file structure matching VS Code / Claude Desktop format */
export interface IMcpServersFile {
  mcpServers: Record<string, IMcpServerConfig>;
}

/** Internal runtime representation of a configured MCP server */
export interface IMcpServerEntry {
  /** Key from mcpServers map, used as namespace segment in tool names */
  id: string;
  /** Derived transport type (honors explicit config.transport for remote servers) */
  transport: "stdio" | "http" | "sse";
  /** Original server config */
  config: IMcpServerConfig;
  /** Whether this server is enabled */
  enabled: boolean;
  /** Require outputSchema on every tool, skip tool if missing */
  strictOutputSchema: boolean;
  /** Optional allowlist of server-side tool names to expose (least privilege) */
  allowedTools?: string[];
}

/** Result of discovering tools from an MCP server */
export interface IMcpServerToolsResult {
  serverId: string;
  /** Names of tools that were loaded successfully */
  loadedToolNames: string[];
  /** Warnings (e.g. tools skipped due to missing outputSchema) */
  warnings: string[];
  /** Connection/discovery error, if any */
  error: string | null;
}
