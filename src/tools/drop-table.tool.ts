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
    tableName: string;
    message: string;
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
      if (!exists) {
        return {
          success: false,
          tableName,
          message: "",
          error: "Internal database is not initialized.",
        };
      }

      await litesql.dropTableAsync(DEFAULT_DATABASE, tableName);

      return {
        success: true,
        tableName,
        message: `Table "${tableName}" dropped`,
      };
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err);
      logger.error("drop-table tool error", { error: errorMsg });
      return {
        success: false,
        tableName,
        message: "",
        error: errorMsg,
      };
    }
  },
});
