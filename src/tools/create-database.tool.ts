import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";

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
  }> => {
    const service: LiteSqlService = LiteSqlService.getInstance();

    const exists: boolean = await service.databaseExistsAsync(databaseName);
    if (exists) {
      throw new Error(`Database "${databaseName}" already exists`);
    }

    await service.createDatabaseAsync(databaseName);

    return {
      success: true,
      databaseName,
      message: `Database "${databaseName}" created successfully at ~/.betterclaw/databases/${databaseName}.db`,
    };
  },
});
