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
  description: "Get the schema (columns and types) of a specific table in the default database",
  inputSchema: z.object({
    tableName: z.string()
      .min(1)
      .describe("Name of the table"),
  }),
  execute: async ({ tableName }: { tableName: string }): Promise<{
    tableName: string;
    columns: z.infer<typeof columnSchema>[];
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
      if (!exists) {
        return {
          tableName,
          columns: [],
          error: "Internal database is not initialized.",
        };
      }

      const tableExists: boolean = await litesql.tableExistsAsync(DEFAULT_DATABASE, tableName);
      if (!tableExists) {
        const tables = await litesql.listTablesAsync(DEFAULT_DATABASE);
        const available: string = tables.join(", ") || "(none)";

        return {
          tableName,
          columns: [],
          error: `Table "${tableName}" does not exist.\nAvailable tables: ${available}`,
        };
      }

      const schema = await litesql.getTableSchemaAsync(DEFAULT_DATABASE, tableName);

      return {
        tableName: schema.name,
        columns: schema.columns,
      };
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err);
      logger.error("get-table-schema tool error", { error: errorMsg });
      return {
        tableName,
        columns: [],
        error: errorMsg,
      };
    }
  },
});
