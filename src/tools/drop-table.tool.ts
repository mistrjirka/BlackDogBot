import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";

export const dropTableTool = tool({
  description: "Drop (delete) a table from a database",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database"),
    tableName: z.string()
      .min(1)
      .describe("Name of the table to drop"),
  }),
  execute: async ({ databaseName, tableName }: { databaseName: string; tableName: string }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    message: string;
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(databaseName);
      if (!exists) {
        const allDbs = await litesql.listDatabasesAsync();
        const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

        return {
          success: false,
          databaseName,
          tableName,
          message: "",
          error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
        };
      }

      await litesql.dropTableAsync(databaseName, tableName);

      return {
        success: true,
        databaseName,
        tableName,
        message: `Table "${tableName}" dropped from database "${databaseName}"`,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("drop-table tool error", { error: errorMsg });
      return {
        success: false,
        databaseName,
        tableName,
        message: "",
        error: errorMsg,
      };
    }
  },
});
