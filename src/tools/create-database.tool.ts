import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";
import { LoggerService } from "../services/logger.service.js";

export const createDatabaseTool = tool({
  description: "Create a new empty SQLite database",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database to create (will be stored in ~/.betterclaw/databases/<name>.db)"),
  }),
  execute: async ({ databaseName }: { databaseName: string }): Promise<{
    success: boolean;
    databaseName: string;
    message: string;
    error?: string;
  }> => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await service.databaseExistsAsync(databaseName);
      if (exists) {
        return {
          success: false,
          databaseName,
          message: "",
          error: `Database "${databaseName}" already exists`,
        };
      }

      await service.createDatabaseAsync(databaseName);

      return {
        success: true,
        databaseName,
        message: `Database "${databaseName}" created successfully at ~/.betterclaw/databases/${databaseName}.db`,
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
