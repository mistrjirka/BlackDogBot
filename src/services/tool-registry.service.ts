import type { ChannelPermission } from "../shared/types/channel.types.js";

//#region Constants

/**
 * Tools that are blocked in read_only mode.
 * These tools perform destructive operations (writes, execution, modifications).
 */
const READ_ONLY_BLOCKED_TOOLS = new Set([
  "run_cmd",
  "write_file",
  "append_file",
  "edit_file",
  "add_knowledge",
  "edit_knowledge",
  "add_cron",
  "edit_cron",
  "remove_cron",
  "add_job",
  "edit_job",
  "remove_job",
  "create_database",
  "create_table",
  "drop_table",
  "write_to_database",
  "modify_prompt",
  "start_job_creation",
  "finish_job_creation",
  "create_output_schema",
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

/**
 * Tools that are part of the job creation system.
 * These are only available when jobCreation.enabled is true.
 */
const JOB_CREATION_TOOLS = new Set([
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

//#endregion Constants

//#region Types

export interface IToolFilterOptions {
  jobCreationEnabled?: boolean;
  skillNames?: string[];
}

//#endregion Types

//#region ToolRegistryService

/**
 * Centralized tool registry with permission-based filtering.
 *
 * This service provides:
 * - Lists of tool names allowed for each permission level
 * - Filtering logic for read_only mode
 * - Job creation tool filtering
 *
 * Note: This service does NOT create tool instances - it only manages
 * the lists of allowed tool names. Tool creation happens in MainAgent.
 */
export class ToolRegistryService {
  //#region Singleton

  private static _instance: ToolRegistryService | null = null;

  public static getInstance(): ToolRegistryService {
    if (!ToolRegistryService._instance) {
      ToolRegistryService._instance = new ToolRegistryService();
    }
    return ToolRegistryService._instance;
  }

  //#endregion Singleton

  //#region Constructor

  private constructor() {}

  //#endregion Constructor

  //#region Public Methods - Tool Name Filtering

  /**
   * Get the list of tool names allowed for a permission level.
   *
   * @param permission The channel's permission level
   * @param options Additional filtering options
   * @returns Array of allowed tool names
   */
  public getAllowedToolNames(
    permission: ChannelPermission,
    options?: IToolFilterOptions
  ): string[] {
    if (permission === "ignore") {
      return [];
    }

    const allowed: string[] = [];

    // Add skill tools first (they're always allowed if permission allows)
    if (options?.skillNames) {
      for (const skillName of options.skillNames) {
        if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(skillName)) {
          continue;
        }
        allowed.push(skillName);
      }
    }

    // Add core tools based on permission
    const coreTools = this._getCoreToolNames(options?.jobCreationEnabled ?? false);

    for (const toolName of coreTools) {
      if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
        continue;
      }
      allowed.push(toolName);
    }

    return allowed;
  }

  /**
   * Check if a specific tool is allowed for a permission level.
   */
  public isToolAllowed(
    toolName: string,
    permission: ChannelPermission,
    options?: IToolFilterOptions
  ): boolean {
    if (permission === "ignore") {
      return false;
    }

    // Check if it's a skill tool
    if (options?.skillNames?.includes(toolName)) {
      if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
        return false;
      }
      return true;
    }

    // Check job creation tools
    if (JOB_CREATION_TOOLS.has(toolName) && !options?.jobCreationEnabled) {
      return false;
    }

    // Check read_only blocked
    if (permission === "read_only" && READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
      return false;
    }

    return true;
  }

  /**
   * Get the list of tool names blocked in read_only mode.
   */
  public getBlockedToolNamesForReadOnly(): string[] {
    return Array.from(READ_ONLY_BLOCKED_TOOLS).sort();
  }

  /**
   * Check if a tool is blocked in read_only mode.
   */
  public isToolBlockedInReadOnly(toolName: string): boolean {
    return READ_ONLY_BLOCKED_TOOLS.has(toolName);
  }

  /**
   * Get all job creation tool names.
   */
  public getJobCreationToolNames(): string[] {
    return Array.from(JOB_CREATION_TOOLS).sort();
  }

  //#endregion Public Methods - Tool Name Filtering

  //#region Private Methods

  private _getCoreToolNames(jobCreationEnabled: boolean): string[] {
    const tools = [
      "think",
      "done",
      "run_cmd",
      "read_file",
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
      "set_job_schedule",
      "remove_job_schedule",
      "searxng",
      "crawl4ai",
      "create_database",
      "list_databases",
      "create_table",
      "drop_table",
      "list_tables",
      "get_table_schema",
      "write_to_database",
      "read_from_database",
      "query_database",
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

  //#endregion Private Methods
}

//#endregion ToolRegistryService
