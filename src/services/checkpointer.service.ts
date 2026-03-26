import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { Database } from "better-sqlite3";
import { LoggerService } from "./logger.service.js";

//#region Public Functions

export function createCheckpointer(db: Database): SqliteSaver {
  const logger: LoggerService = LoggerService.getInstance();

  const saver = SqliteSaver.fromConnString(db.name);

  logger.info("LangGraph SqliteSaver checkpointer initialized");

  return saver;
}

//#endregion Public Functions