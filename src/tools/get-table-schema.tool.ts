import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";

const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  notNull: z.boolean(),
  primaryKey: z.boolean(),
  defaultValue: z.string().nullable(),
});

export const getTableSchemaTool = tool({
  description: "Get the schema (columns and types) of a specific table",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database"),
    tableName: z.string()
      .min(1)
      .describe("Name of the table"),
  }),
  execute: async ({ databaseName, tableName }: { databaseName: string; tableName: string }): Promise<{
    databaseName: string;
    tableName: string;
    columns: z.infer<typeof columnSchema>[];
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

    const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const tables = await service.listTablesAsync(databaseName);
      const available: string = tables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${databaseName}".\n` +
          `Available tables: ${available}`,
      );
    }

    const schema = await service.getTableSchemaAsync(databaseName, tableName);

    return {
      databaseName,
      tableName: schema.name,
      columns: schema.columns,
    };
  },
});
