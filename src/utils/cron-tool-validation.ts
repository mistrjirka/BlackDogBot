import { CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { McpService } from "../services/mcp.service.js";

const _DYNAMIC_TABLE_PREFIXES: readonly string[] = ["write_table_", "update_table_"] as const;

const _DYNAMIC_SUFFIX_REGEX: RegExp = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isDynamicTableToolName(toolName: string): boolean {
  for (const prefix of _DYNAMIC_TABLE_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      const suffix: string = toolName.slice(prefix.length);
      return _DYNAMIC_SUFFIX_REGEX.test(suffix);
    }
  }
  return false;
}

/** Keep old scheduled tasks working without restoring the built-in HTTP client. */
export function resolveLegacyCronToolName(toolName: string): string {
  return toolName === "searxng" ? "mcp.searxng.searxng_web_search" : toolName;
}

/**
 * MCP tools are discovered at runtime: do not accept obsolete hardcoded
 * names from a previous scraper installation or reject newly installed ones.
 * An unavailable server is a real task setup error, not a silently missing tool.
 */
export function getAvailableCronToolNames(): string[] {
  const connected = Object.keys(McpService.getInstance().getTools());
  return [
    ...CRON_VALID_TOOL_NAMES.filter((name) => name !== "searxng" || connected.includes(resolveLegacyCronToolName(name))),
    ...connected,
  ];
}

export function filterInvalidTools(tools: string[]): string[] {
  const validToolSet: ReadonlySet<string> = new Set(getAvailableCronToolNames());
  return tools.filter((t) => !validToolSet.has(t) && !isDynamicTableToolName(t));
}

export function getMissingCronTools(
  requestedNames: readonly string[],
  availableTools: Readonly<Record<string, unknown>>,
): string[] {
  // delegate_agent is attached after base tools are resolved; it is not
  // present in the initial tool map, but is an intentional special case.
  return requestedNames.filter((name) => name !== "delegate_agent" && !(resolveLegacyCronToolName(name) in availableTools));
}