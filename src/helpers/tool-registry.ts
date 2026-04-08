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
  "remove_cron",
  "add_once",
  "add_interval",
  "edit_once",
  "edit_interval",
  "edit_instructions",
  "remove_timed",
  "add_job",
  "edit_job",
  "remove_job",
  "add_node_test",
  "add_agent_node",
  "add_python_code_node",
  "add_litesql_node",
  "add_litesql_reader_node",
  "add_curl_fetcher_node",
  "add_rss_fetcher_node",
  "add_searxng_node",
  "add_crawl4ai_node",
  "add_output_to_ai_node",
  "edit_node",
  "remove_node",
  "connect_nodes",
  "disconnect_nodes",
  "set_entrypoint",
  "clear_job_graph",
  "set_job_schedule",
  "remove_job_schedule",
  "finish_job",
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

const JOB_CREATION_TOOLS: Set<string> = new Set([
  "start_job_creation",
  "finish_job_creation",
  "create_output_schema",
  "add_node_test",
  "run_node_test",
  "add_agent_node",
  "add_python_code_node",
  "add_litesql_node",
  "add_litesql_reader_node",
  "add_curl_fetcher_node",
  "add_rss_fetcher_node",
  "add_searxng_node",
  "add_crawl4ai_node",
  "add_output_to_ai_node",
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
  "set_job_schedule",
  "remove_job_schedule",
  "searxng",
  "crawl4ai",
  "list_tables",
  "create_table",
  "drop_table",
  "get_table_schema",
  "read_from_database",
  "delete_from_database",
  "list_prompts",
  "modify_prompt",
  "get_skill_file",
  "add_job",
  "edit_job",
  "remove_job",
  "get_jobs",
  "run_job",
  "finish_job",
  "get_nodes",
  "edit_node",
  "remove_node",
  "connect_nodes",
  "disconnect_nodes",
  "set_entrypoint",
  "clear_job_graph",
  "render_graph",
];

//#endregion Constants

//#region Types

export interface IToolFilterOptions {
  jobCreationEnabled?: boolean;
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

  // MCP tools are blocked in read_only by default
  if (permission === "read_only") {
    // Filtered below per-tool
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

  const coreTools: string[] = getCoreToolNames(options?.jobCreationEnabled ?? false);

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

  if (options?.skillNames?.includes(toolName)) {
    if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
      return false;
    }
    return true;
  }

  if (JOB_CREATION_TOOLS.has(toolName) && !options?.jobCreationEnabled) {
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

export function getJobCreationToolNames(): string[] {
  return [];
}

//#endregion Public Functions

//#region Private Functions

function getCoreToolNames(jobCreationEnabled: boolean): string[] {
  const tools: string[] = [...CORE_TOOL_NAMES];

  if (jobCreationEnabled) {
    tools.push(
      "start_job_creation",
      "finish_job_creation",
      "create_output_schema",
      "add_node_test",
      "run_node_test",
      "add_agent_node",
      "add_python_code_node",
      "add_litesql_node",
      "add_litesql_reader_node",
      "add_curl_fetcher_node",
      "add_rss_fetcher_node",
      "add_searxng_node",
      "add_crawl4ai_node",
      "add_output_to_ai_node"
    );
  }

  return tools;
}

//#endregion Private Functions
