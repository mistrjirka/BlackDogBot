import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

const DEFAULT_DATABASE = "blackdog";

export const dropTableTool = tool({
  description: "Drop (delete) a table from the default database",
  inputSchema: z.object({
    tableName: z.string()
      .min(1)
      .describe("Name of the table to drop"),
  }),
  execute: async ({ tableName }: { tableName: string }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    message: string;
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
      if (!exists) {
        const allDbs = await litesql.listDatabasesAsync();
        const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

        return {
          success: false,
          databaseName: DEFAULT_DATABASE,
          tableName,
          message: "",
          error: `Database "${DEFAULT_DATABASE}" does not exist.\nAvailable databases: ${available}`,
        };
      }

      await litesql.dropTableAsync(DEFAULT_DATABASE, tableName);

      return {
        success: true,
        databaseName: DEFAULT_DATABASE,
        tableName,
        message: `Table "${tableName}" dropped from database "${DEFAULT_DATABASE}"`,
      };
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err);
      logger.error("drop-table tool error", { error: errorMsg });
      return {
        success: false,
        databaseName: DEFAULT_DATABASE,
        tableName,
        message: "",
        error: errorMsg,
      };
    }
  },
});
