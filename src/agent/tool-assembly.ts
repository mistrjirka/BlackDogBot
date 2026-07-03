import type { ToolSet } from "ai";
import {
  thinkTool,
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
  crawl4aiTool,
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
  createCallSkillTool,
  getSkillFileTool,
  FileReadTracker,
} from "../tools/index.js";
import { createKnowledgeToolFactory } from "../tools/knowledge-tool-factory.js";
import { LoggerService } from "../services/logger.service.js";
import { ChannelRegistryService } from "../services/channel-registry.service.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import * as toolRegistry from "../helpers/tool-registry.js";
import * as knowledge from "../helpers/knowledge.js";
import type { McpService } from "../services/mcp.service.js";
import type { IFileReadTracker } from "../utils/file-tools-helper.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";

export async function assembleToolsForChat(
  chatId: string,
  messageSender: MessageSender,
  readTracker: FileReadTracker,
  aiProviderService?: import("../services/ai-provider.service.js").AiProviderService,
  mcpService?: McpService,
  skillLoaderService?: SkillLoaderService,
  platform: MessagePlatform = "telegram",
): Promise<ToolSet> {
  const tools = createBaseToolSet(messageSender, readTracker);

  // Add read_image if vision is supported
  if (aiProviderService?.getSupportsVision()) {
    tools.read_image = createReadImageTool(readTracker as IFileReadTracker);
  }

  // Only include skill tools if skills are actually loaded
  const availableSkills = skillLoaderService?.getAvailableSkills() ?? [];
  if (availableSkills.length > 0) {
    const skillNames = availableSkills.map((s): string => s.name);
    tools.call_skill = createCallSkillTool(skillNames);
    tools.get_skill_file = getSkillFileTool;
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

  // Filter tools based on permission
  return filterToolsByPermission(tools, { platform, chatId });
}

function createBaseToolSet(messageSender: MessageSender, readTracker: FileReadTracker): ToolSet {
  const knowledgeToolFactory = createKnowledgeToolFactory({
    knowledgeService: knowledge,
    messageService: {
      sendAsync: messageSender,
    },
  });

  const tools: ToolSet = {
    think: thinkTool,
    run_cmd: runCmdTool,
    run_cmd_input: runCmdInputTool,
    get_cmd_status: getCmdStatusTool,
    get_cmd_output: getCmdOutputTool,
    wait_for_cmd: waitForCmdTool,
    stop_cmd: stopCmdTool,
    modify_prompt: modifyPromptTool,
    list_prompts: listPromptsTool,
    search_knowledge: knowledgeToolFactory.createSearchKnowledgeTool(),
    add_knowledge: knowledgeToolFactory.createAddKnowledgeTool(),
    edit_knowledge: knowledgeToolFactory.createEditKnowledgeTool(),
    send_message: knowledgeToolFactory.createSendMessageTool(),
    read_file: createReadFileTool(readTracker as IFileReadTracker),
    write_file: createWriteFileTool(readTracker as IFileReadTracker),
    append_file: appendFileTool,
    edit_file: editFileTool,
    remove_timed: removeTimedTool,
    list_timed: listTimedTool,
    get_timed: getTimedTool,
    run_timed: runTimedTool,
    fetch_rss: fetchRssTool,
    list_tables: listTablesTool,
    get_table_schema: getTableSchemaTool,
    drop_table: dropTableTool,
    read_from_database: readFromDatabaseTool,
    delete_from_database: deleteFromDatabaseTool,
    searxng: searxngTool,
    crawl4ai: crawl4aiTool,
    search_timed: searchTimedTool,
  };

  // Add cron/timed tools separately for clarity
  tools.add_once = addOnceTool;
  tools.add_interval = addIntervalTool;
  tools.edit_once = editOnceTool;
  tools.edit_interval = editIntervalTool;
  tools.edit_instructions = editInstructionsTool;

  return tools;
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
    if (toolRegistry.isToolAllowed(toolName, permission, {})) {
      filteredTools[toolName] = tool;
    }
  }

  return filteredTools;
}
