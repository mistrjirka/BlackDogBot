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
  "add_cron",
  "edit_cron",
  "edit_cron_instructions",
  "remove_cron",
  "create_database",
  "create_table",
  "drop_table",
  "delete_from_database",
  "modify_prompt",
]);

const CORE_TOOL_NAMES: string[] = [
  "think",
  "run_cmd",
  "run_cmd_input",
  "get_cmd_status",
  "get_cmd_output",
  "wait_for_cmd",
  "stop_cmd",
  "read_file",
  "read_image",
  "write_file",
  "append_file",
  "edit_file",
  "search_knowledge",
  "add_knowledge",
  "edit_knowledge",
  "send_message",
  "fetch_rss",
  "add_cron",
  "remove_cron",
  "list_crons",
  "get_cron",
  "edit_cron",
  "edit_cron_instructions",
  "run_cron",
  "searxng",
  "crawl4ai",
  "create_database",
  "list_databases",
  "create_table",
  "drop_table",
  "list_tables",
  "get_table_schema",
  "read_from_database",
  "delete_from_database",
  "query_database",
  "list_prompts",
  "modify_prompt",
  "get_skill_file",
];

//#endregion Constants

//#region Types

export interface IToolFilterOptions {
  skillNames?: string[];
}

//#endregion Types

//#region Public Functions

export function getAllowedToolNames(
  permission: ChannelPermission,
  options?: IToolFilterOptions
): string[] {
  if (permission === "ignore") {
    return [];
  }

  const allowed: string[] = [];

  if (options?.skillNames) {
    for (const skillName of options.skillNames) {
      if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(skillName)) {
        continue;
      }
      allowed.push(skillName);
    }
  }

  const coreTools: string[] = getCoreToolNames();

  for (const toolName of coreTools) {
    if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
      continue;
    }
    allowed.push(toolName);
  }

  return allowed;
}

export function isToolAllowed(
  toolName: string,
  permission: ChannelPermission,
  options?: IToolFilterOptions
): boolean {
  if (permission === "ignore") {
    return false;
  }

  // MCP tools are blocked in read_only by default
  if (permission === "read_only" && toolName.startsWith("mcp.")) {
    return false;
  }

  // Per-table write tools (write_table_<tableName>) are blocked in read_only
  if (permission === "read_only" && toolName.startsWith("write_table_")) {
    return false;
  }

  // Per-table update tools (update_table_<tableName>) are blocked in read_only
  if (permission === "read_only" && toolName.startsWith("update_table_")) {
    return false;
  }

  if (options?.skillNames?.includes(toolName)) {
    if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
      return false;
    }
    return true;
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
