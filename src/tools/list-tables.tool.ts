import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

const DEFAULT_DATABASE = "blackdog";

export const listTablesTool = tool({
  description: "List all tables in the internal database",
  inputSchema: z.object({}).strict(),
  execute: async (): Promise<{
    tables: string[];
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
      if (!exists) {
        return {
          tables: [],
          error: "Internal database is not initialized.",
        };
      }

      const tables: string[] = await litesql.listTablesAsync(DEFAULT_DATABASE);

      return {
        tables,
      };
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err);
      logger.error("list_tables tool error", { error: errorMsg });
      return {
        tables: [],
        error: errorMsg,
      };
    }
  },
});
