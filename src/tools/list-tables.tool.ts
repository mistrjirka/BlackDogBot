import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";

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

    const tables: string[] = await service.listTablesAsync(databaseName);

    return {
      databaseName,
      tables,
    };
  },
});
