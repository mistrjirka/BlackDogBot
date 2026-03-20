import { z } from "zod";

/** Zod schema for a single MCP server entry (VS Code / Claude Desktop format) */
export const mcpServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.string().array().optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).refine(
  (config) => !!config.command || !!config.url,
  "Server must have either 'command' (stdio) or 'url' (http/sse)",
);

/** Zod schema for the top-level config file */
export const mcpServersFileSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});
