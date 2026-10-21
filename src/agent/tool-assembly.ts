import type { Tool, ToolExecutionOptions, ToolSet } from "ai";
import {
  thinkTool,
  createTableTool,
  runCmdTool,
  runCmdInputTool,
  getCmdStatusTool,
  getCmdOutputTool,
  waitForCmdTool,
  stopCmdTool,
  modifyPromptTool,
  listPromptsTool,
  type MessageSender,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  fetchRssTool,
  listTablesTool,
  getTableSchemaTool,
  dropTableTool,
  readFromDatabaseTool,
  deleteFromDatabaseTool,
  searxngTool,
  searchTimedTool,
  addOnceTool,
  addIntervalTool,
  editOnceTool,
  editIntervalTool,
  editInstructionsTool,
  removeTimedTool,
  listTimedTool,
  getTimedTool,
  runTimedTool,
  createReadImageTool,
  loadSkillTool,
  listSkillsTool,
  getSkillFileTool,
  type FileReadTracker,
} from "../tools/index.js";
import { createKnowledgeToolFactory } from "../tools/knowledge-tool-factory.js";
import { LoggerService } from "../services/logger.service.js";
import { ChannelRegistryService } from "../services/channel-registry.service.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import * as toolRegistry from "../helpers/tool-registry.js";
import * as knowledge from "../helpers/knowledge.js";
import type { McpService } from "../services/mcp.service.js";
import type { AiProviderService } from "../services/ai-provider.service.js";
import { attachDelegateAgentTool } from "./delegate-agent.js";
import type { IFileReadTracker } from "../utils/file-tools-helper.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";
import type { ICreateTableRebuildInfo } from "../shared/types/tool-rebuild.types.js";
import { createInspectVariableTool } from "../tools/inspect-variable.tool.js";
import type { VariableStore } from "../utils/variable-store.js";

export async function assembleToolsForChat(
  chatId: string,
  messageSender: MessageSender,
  readTracker: FileReadTracker,
  aiProviderService?: AiProviderService,
  mcpService?: McpService,
  platform: MessagePlatform = "telegram",
  onCreateTableAsync?: (info: ICreateTableRebuildInfo) => void | Promise<void>,
  getVariableStore?: () => VariableStore | null,
): Promise<ToolSet> {
  const tools = createBaseToolSet(messageSender, readTracker);

  // Add read_image if vision is supported
  if (aiProviderService?.getSupportsVision()) {
    tools.read_image = createReadImageTool(readTracker as IFileReadTracker);
  }

  tools.list_skills = listSkillsTool;
  tools.load_skill = loadSkillTool;
  tools.get_skill_file = getSkillFileTool;
  if (getVariableStore) {
    tools.inspect_variable = createInspectVariableTool(getVariableStore);
  }

  // Merge MCP tools from connected servers
  const mcpTools: ToolSet = mcpService?.getTools() ?? {};
  for (const [toolName, toolDef] of Object.entries(mcpTools)) {
    tools[toolName] = toolDef;
  }

  // Merge per-table write tools (generated from database schemas)
  const perTableResult = await buildPerTableToolsAsync();
  if (perTableResult.dbStatus === "corrupt") {
    LoggerService.getInstance().error("Database corrupt - per-table tools unavailable at startup", {
      dbStatus: perTableResult.dbStatus,
    });
  }
  for (const [toolName, toolDef] of Object.entries(perTableResult.tools)) {
    tools[toolName] = toolDef;
  }

  // create_table in chat: the prompt directs the agent to create tables in the
  // conversation ("do table setup in this conversation"). The wrapper triggers
  // the post-create rebuild so write_table_<name>/update_table_<name> become
  // available without waiting for a re-init.
  tools.create_table = wrapCreateTableTool(createTableTool, onCreateTableAsync);

  const filteredTools: ToolSet = filterToolsByPermission(tools, { platform, chatId });
  if (aiProviderService && ChannelRegistryService.getInstance().getPermission(platform, chatId) !== "ignore") {
    attachDelegateAgentTool(filteredTools, aiProviderService.getModel());
  }
  return filteredTools;
}

/**
 * Base tool set shared by the chat agent (MainAgent) and the cron agent.
 * Chat-only tools (task management, plain send_message, prompt tools) and
 * cron-only tools (send_message with history, get_previous_message) are added
 * by the respective callers; create_table is added by both callers with a
 * post-create rebuild hook.
 */
export function createAgentBaseToolSet(
  messageSender: MessageSender,
  readTracker: FileReadTracker,
): ToolSet {
  const knowledgeToolFactory = createKnowledgeToolFactory({
    knowledgeService: knowledge,
    messageService: {
      sendAsync: messageSender,
    },
  });

  return {
    think: thinkTool,
    run_cmd: runCmdTool,
    run_cmd_input: runCmdInputTool,
    get_cmd_status: getCmdStatusTool,
    get_cmd_output: getCmdOutputTool,
    wait_for_cmd: waitForCmdTool,
    stop_cmd: stopCmdTool,
    search_knowledge: knowledgeToolFactory.createSearchKnowledgeTool(),
    add_knowledge: knowledgeToolFactory.createAddKnowledgeTool(),
    edit_knowledge: knowledgeToolFactory.createEditKnowledgeTool(),
    read_file: createReadFileTool(readTracker as IFileReadTracker),
    write_file: createWriteFileTool(readTracker as IFileReadTracker),
    append_file: appendFileTool,
    edit_file: editFileTool,
    list_timed: listTimedTool,
    fetch_rss: fetchRssTool,
    searxng: searxngTool,
    search_timed: searchTimedTool,
    list_tables: listTablesTool,
    get_table_schema: getTableSchemaTool,
    drop_table: dropTableTool,
    read_from_database: readFromDatabaseTool,
    delete_from_database: deleteFromDatabaseTool,
  };
}

export function createBaseToolSet(messageSender: MessageSender, readTracker: FileReadTracker): ToolSet {
  const knowledgeToolFactory = createKnowledgeToolFactory({
    knowledgeService: knowledge,
    messageService: {
      sendAsync: messageSender,
    },
  });

  const tools: ToolSet = {
    ...createAgentBaseToolSet(messageSender, readTracker),
    modify_prompt: modifyPromptTool,
    list_prompts: listPromptsTool,
    send_message: knowledgeToolFactory.createSendMessageTool(),
    remove_timed: removeTimedTool,
    get_timed: getTimedTool,
    run_timed: runTimedTool,
  };

  // Add cron/timed tools separately for clarity
  tools.add_once = addOnceTool;
  tools.add_interval = addIntervalTool;
  tools.edit_once = editOnceTool;
  tools.edit_interval = editIntervalTool;
  tools.edit_instructions = editInstructionsTool;

  return tools;
}

/**
 * Wraps the create_table tool so that a successful create triggers a
 * post-create rebuild hook (per-table write/update tools). Shared by the chat
 * and cron agents; the hook may be async (the chat path awaits it so the
 * agent is rebuilt before the run loop restarts generate()).
 */
export function wrapCreateTableTool(
  originalTool: Tool,
  onCreateTableAsync?: (info: ICreateTableRebuildInfo) => void | Promise<void>,
): Tool {
  const originalExecute = originalTool.execute;

  if (!originalExecute) {
    return originalTool;
  }

  interface ICreateTableToolResult {
    success?: boolean;
    [key: string]: unknown;
  }

  return {
    ...originalTool,
    execute: async (input: unknown, options: ToolExecutionOptions<unknown>): Promise<unknown> => {
      const result = await originalExecute(input, options) as ICreateTableToolResult;

      if (result?.success === true && onCreateTableAsync) {
        const tableName: string = typeof input === "object" && input !== null
          ? String((input as Record<string, unknown>).tableName ?? "unknown")
          : "unknown";

        await onCreateTableAsync({
          toolName: `write_table_${tableName}`,
          tableName,
        });
      }

      return result;
    },
  };
}

function filterToolsByPermission(
  tools: ToolSet,
  options: { platform: string; chatId: string },
): ToolSet {
  // Check READ_ONLY_BLOCKED_TOOLS first
  const channelRegistry = ChannelRegistryService.getInstance();
  const permission = channelRegistry.getPermission(options.platform, options.chatId);

  const filteredTools: ToolSet = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    if (toolRegistry.isToolAllowed(toolName, permission)) {
      filteredTools[toolName] = tool;
    }
  }

  return filteredTools;
}
