import { tool } from "langchain";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";

export const listDatabasesTool = tool(
  async (): Promise<{
    databases: {
      name: string;
      tableCount: number;
      sizeBytes: number;
      createdAt: string;
    }[];
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const databases = await litesql.listDatabasesAsync();

      return {
        databases: databases.map((db) => ({
          name: db.name,
          tableCount: db.tableCount,
          sizeBytes: db.sizeBytes,
          createdAt: db.createdAt,
        })),
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("list_databases tool error", { error: errorMsg });
      return {
        databases: [],
        error: errorMsg,
      };
    }
  },
  {
    name: "list_databases",
    description: "List all available databases.",
    schema: z.object({}),
  },
);
