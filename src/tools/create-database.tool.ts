import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";

export const createDatabaseTool = tool({
  description: "Create a new empty SQLite database",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database to create (without .db extension)"),
  }),
  execute: async ({ databaseName }: { databaseName: string }): Promise<{
    success: boolean;
    databaseName: string;
    message: string;
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(databaseName);
      if (exists) {
        return {
          success: false,
          databaseName,
          message: "",
          error: `Database "${databaseName}" already exists`,
        };
      }

      await litesql.createDatabaseAsync(databaseName);

      return {
        success: true,
        databaseName,
        message: `Database "${databaseName}" created successfully.`,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("create-database tool error", { error: errorMsg });
      return {
        success: false,
        databaseName,
        message: "",
        error: errorMsg,
      };
    }
  },
});
