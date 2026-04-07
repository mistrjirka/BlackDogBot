import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

const DEFAULT_DATABASE = "blackdog";

const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  notNull: z.boolean(),
  primaryKey: z.boolean(),
  defaultValue: z.string().nullable(),
});

export const getTableSchemaTool = tool({
  description: "Get the schema (columns and types) of a specific table in the default database (blackdog)",
  inputSchema: z.object({
    tableName: z.string()
      .min(1)
      .describe("Name of the table"),
  }),
  execute: async ({ tableName }: { tableName: string }): Promise<{
    databaseName: string;
    tableName: string;
    columns: z.infer<typeof columnSchema>[];
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
      if (!exists) {
        const allDbs = await litesql.listDatabasesAsync();
        const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

        return {
          databaseName: DEFAULT_DATABASE,
          tableName,
          columns: [],
          error: `Database "${DEFAULT_DATABASE}" does not exist.\nAvailable databases: ${available}`,
        };
      }

      const tableExists: boolean = await litesql.tableExistsAsync(DEFAULT_DATABASE, tableName);
      if (!tableExists) {
        const tables = await litesql.listTablesAsync(DEFAULT_DATABASE);
        const available: string = tables.join(", ") || "(none)";

        return {
          databaseName: DEFAULT_DATABASE,
          tableName,
          columns: [],
          error: `Table "${tableName}" does not exist in database "${DEFAULT_DATABASE}".\nAvailable tables: ${available}`,
        };
      }

      const schema = await litesql.getTableSchemaAsync(DEFAULT_DATABASE, tableName);

      return {
        databaseName: DEFAULT_DATABASE,
        tableName: schema.name,
        columns: schema.columns,
      };
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err);
      logger.error("get-table-schema tool error", { error: errorMsg });
      return {
        databaseName: DEFAULT_DATABASE,
        tableName,
        columns: [],
        error: errorMsg,
      };
    }
  },
});
