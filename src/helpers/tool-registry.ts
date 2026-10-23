import type { ChannelPermission } from "../shared/types/channel.types.js";

//#region Constants

const READ_ONLY_BLOCKED_TOOLS: Set<string> = new Set([
  "run_cmd",
  "run_cmd_input",
  "wait_for_cmd",
  "stop_cmd",
  "read_image",
  "write_file",
  "append_file",
  "edit_file",
  "add_knowledge",
  "edit_knowledge",
  "add_once",
  "add_interval",
  "edit_once",
  "edit_interval",
  "edit_instructions",
  "remove_timed",
  "delete_from_database",
  "drop_table",
]);

/**
 * Narrow read-only MCP allowlist. One-shot Scrapling fetching is a remote
 * read; persistent sessions and arbitrary browser actions are full permission.
 * Reevaluate whenever the configured MCP scraper changes.
 */
const MCP_READ_ONLY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "mcp.searxng.searxng_web_search",
  "mcp.searxng.searxng_search_suggestions",
  "mcp.searxng.searxng_instance_info",
  "mcp.searxng.web_url_read",
  "mcp.scrapling.browser_fetch_once",
]);

export const TIMED_VALID_TOOL_NAMES = [
  "add_once",
  "add_interval",
  "edit_once",
  "edit_interval",
  "edit_instructions",
  "remove_timed",
  "list_timed",
  "get_timed",
  "run_timed",
] as const;

const CORE_TOOL_NAMES: string[] = [
  "think",
  "run_cmd",
  "run_cmd_input",
  "get_cmd_status",
  "get_cmd_output",
  "wait_for_cmd",
  "stop_cmd",
  "read_file",
  "inspect_variable",
  "read_image",
  "write_file",
  "append_file",
  "edit_file",
  "search_knowledge",
  "add_knowledge",
  "edit_knowledge",
  "send_message",
  "fetch_rss",
  "add_once",
  "add_interval",
  "remove_timed",
  "list_timed",
  "get_timed",
  "edit_once",
  "edit_interval",
  "edit_instructions",
  "list_tables",
  "create_table",
  "drop_table",
  "get_table_schema",
  "read_from_database",
  "delete_from_database",
  "list_prompts",
  "modify_prompt",
  "get_skill_file",
  "list_skills",
  "load_skill",
  "delegate_agent",
];

//#endregion Constants


//#region Public Functions

export function getAllowedToolNames(permission: ChannelPermission): string[] {
  if (permission === "ignore") {
    return [];
  }

  const allowed: string[] = [];
  const coreTools: string[] = getCoreToolNames();

  for (const toolName of coreTools) {
    if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
      continue;
    }
    allowed.push(toolName);
  }

  return allowed;
}

export function isToolAllowed(toolName: string, permission: ChannelPermission): boolean {
  if (permission === "ignore") {
    return false;
  }

  if (permission === "read_only" && toolName.startsWith("mcp.")) {
    return MCP_READ_ONLY_SAFE_TOOLS.has(toolName);
  }

  if (permission === "read_only" && toolName.startsWith("write_table_")) {
    return false;
  }

  if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
    return false;
  }

  return true;
}

export function getBlockedToolNamesForReadOnly(): string[] {
  return Array.from(READ_ONLY_BLOCKED_TOOLS).sort();
}

export function isToolBlockedInReadOnly(toolName: string): boolean {
  return READ_ONLY_BLOCKED_TOOLS.has(toolName);
}

//#endregion Public Functions

//#region Private Functions

function getCoreToolNames(): string[] {
  return [...CORE_TOOL_NAMES];
}

//#endregion Private Functions
