import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

export const listTablesTool = tool({
  description: "List all tables in a specific database",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database"),
  }),
  execute: async ({ databaseName }: { databaseName: string }): Promise<{
    databaseName: string;
    tables: string[];
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(databaseName);
      if (!exists) {
        const allDbs = await litesql.listDatabasesAsync();
        const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

        return {
          databaseName,
          tables: [],
          error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
        };
      }

      const tables: string[] = await litesql.listTablesAsync(databaseName);

      return {
        databaseName,
        tables,
      };
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err);
      logger.error("list_tables tool error", { databaseName, error: errorMsg });
      return {
        databaseName,
        tables: [],
        error: errorMsg,
      };
    }
  },
});
