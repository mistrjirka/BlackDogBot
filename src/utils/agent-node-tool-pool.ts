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
  writeToDatabaseTool,
  readFromDatabaseTool,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  createTableTool,
  FileReadTracker,
} from "../tools/index.js";

export type AgentNodeMessageSender = (message: string) => Promise<string | null>;

export function createAgentNodeToolPool(
  logger: LoggerService,
  messageSender?: AgentNodeMessageSender,
): Record<string, ToolSet[string]> {
  const effectiveSender: AgentNodeMessageSender = messageSender ?? (async (message: string): Promise<string | null> => {
    logger.info("Agent node message", { message });
    return null;
  });

  const readTracker: FileReadTracker = new FileReadTracker();

  return {
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
    write_to_database: writeToDatabaseTool,
    read_from_database: readFromDatabaseTool,
    list_databases: listDatabasesTool,
    list_tables: listTablesTool,
    get_table_schema: getTableSchemaTool,
    create_table: createTableTool,
  };
}

export function getAgentNodeToolNames(): string[] {
  return Object.keys(createAgentNodeToolPool(LoggerService.getInstance()));
}
