import { type ToolSet } from "ai";

import { LoggerService } from "../services/logger.service.js";
import {
  runCmdTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  thinkTool,
  createSendMessageTool,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  readFromDatabaseTool,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  createTableTool,
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

  const staticTools: Record<string, ToolSet[string]> = {
    think: thinkTool,
    run_cmd: runCmdTool,
    search_knowledge: searchKnowledgeTool,
    add_knowledge: addKnowledgeTool,
    edit_knowledge: editKnowledgeTool,
    send_message: createSendMessageTool(effectiveSender),
    read_file: createReadFileTool(readTracker),
    write_file: createWriteFileTool(readTracker),
    append_file: appendFileTool,
    edit_file: editFileTool,
    read_from_database: readFromDatabaseTool,
    list_databases: listDatabasesTool,
    list_tables: listTablesTool,
    get_table_schema: getTableSchemaTool,
    create_table: createTableTool,
  };

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
