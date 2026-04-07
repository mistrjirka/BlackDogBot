import { type ToolSet } from "ai";

import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import {
  runCmdTool,
  runCmdInputTool,
  getCmdStatusTool,
  getCmdOutputTool,
  waitForCmdTool,
  stopCmdTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  thinkTool,
  createSendMessageTool,
  createReadFileTool,
  createReadImageTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  readFromDatabaseTool,
  deleteFromDatabaseTool,
  listTablesTool,
  getTableSchemaTool,
  createTableTool,
  dropTableTool,
  FileReadTracker,
} from "../tools/index.js";
import { buildPerTableToolsAsync } from "./per-table-tools.js";

export type AgentNodeMessageSender = (message: string) => Promise<string | null>;

export function createAgentNodeToolPool(
  logger: LoggerService,
  messageSender?: AgentNodeMessageSender,
  perTableTools?: ToolSet,
): Record<string, ToolSet[string]> {
  const effectiveSender: AgentNodeMessageSender = messageSender ?? (async (message: string): Promise<string | null> => {
    logger.info("Agent node message", { message });
    return null;
  });

  const readTracker: FileReadTracker = new FileReadTracker();
  let supportsVision: boolean = false;
  try {
    supportsVision = AiProviderService.getInstance().getSupportsVision();
  } catch {
    supportsVision = false;
  }

  const staticTools: Record<string, ToolSet[string]> = {
    think: thinkTool,
    run_cmd: runCmdTool,
    run_cmd_input: runCmdInputTool,
    get_cmd_status: getCmdStatusTool,
    get_cmd_output: getCmdOutputTool,
    wait_for_cmd: waitForCmdTool,
    stop_cmd: stopCmdTool,
    search_knowledge: searchKnowledgeTool,
    add_knowledge: addKnowledgeTool,
    edit_knowledge: editKnowledgeTool,
    send_message: createSendMessageTool(effectiveSender),
    read_file: createReadFileTool(readTracker),
    write_file: createWriteFileTool(readTracker),
    append_file: appendFileTool,
    edit_file: editFileTool,
    read_from_database: readFromDatabaseTool,
    delete_from_database: deleteFromDatabaseTool,
    list_tables: listTablesTool,
    get_table_schema: getTableSchemaTool,
    create_table: createTableTool,
    drop_table: dropTableTool,
  };

  if (supportsVision) {
    staticTools.read_image = createReadImageTool(readTracker);
  }

  if (!perTableTools) {
    return staticTools;
  }

  return {
    ...staticTools,
    ...perTableTools,
  };
}

export async function getAgentNodeToolNamesAsync(): Promise<string[]> {
  const perTableTools: ToolSet = await buildPerTableToolsAsync();
  return Object.keys(createAgentNodeToolPool(LoggerService.getInstance(), undefined, perTableTools));
}
