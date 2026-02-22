import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";

export const listDatabasesTool = tool({
  description: "List all available SQLite databases in ~/.betterclaw/databases/",
  inputSchema: z.object({}),
  execute: async (): Promise<{
    databases: {
      name: string;
      tableCount: number;
      sizeBytes: number;
      createdAt: string;
    }[];
  }> => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    const databases = await service.listDatabasesAsync();

    return {
      databases: databases.map((db) => ({
        name: db.name,
        tableCount: db.tableCount,
        sizeBytes: db.sizeBytes,
        createdAt: db.createdAt,
      })),
    };
  },
});
