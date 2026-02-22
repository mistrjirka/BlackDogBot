import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";

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
  }> => {
    const service: LiteSqlService = LiteSqlService.getInstance();

    const exists: boolean = await service.databaseExistsAsync(databaseName);
    if (!exists) {
      const allDbs = await service.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      throw new Error(
        `Database "${databaseName}" does not exist.\n` +
          `Available databases: ${available}`,
      );
    }

    await service.dropTableAsync(databaseName, tableName);

    return {
      success: true,
      databaseName,
      tableName,
      message: `Table "${tableName}" dropped from database "${databaseName}"`,
    };
  },
});
