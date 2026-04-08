import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IColumnInfo } from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { columnsToJsonSchema, IJsonSchema } from "../utils/litesql-schema-helper.js";

const DEFAULT_DATABASE = "blackdog";

const columnDefinitionSchema = z.object({
  name: z.string()
    .min(1)
    .describe("Column name"),
  type: z.enum(["TEXT", "INTEGER", "REAL", "BLOB"])
    .describe("SQL data type"),
  primaryKey: z.boolean()
    .default(false)
    .describe("Whether this column is the primary key"),
  notNull: z.boolean()
    .default(false)
    .describe("Whether this column cannot be NULL"),
  defaultValue: z.string()
    .optional()
    .describe("Default value for the column"),
});

export const createTableTool = tool({
  description: "Create a new table in the default database. Call this after prerequisite checks/tool calls are complete for the current run.",
  inputSchema: z.object({
    tableName: z.string()
      .min(1)
      .describe("Name of the table to create"),
    columns: columnDefinitionSchema
      .array()
      .min(1)
      .describe("Array of column definitions"),
  }),
  execute: async ({
    tableName,
    columns,
  }: {
    tableName: string;
    columns: z.infer<typeof columnDefinitionSchema>[];
  }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    columns: IColumnInfo[];
    inputSchema: IJsonSchema;
    message: string;
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      let dbExists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
      if (!dbExists) {
        await litesql.createDatabaseAsync(DEFAULT_DATABASE);
        dbExists = true;
      }

      const tableExists: boolean = await litesql.tableExistsAsync(DEFAULT_DATABASE, tableName);
      if (tableExists) {
        return {
          success: false,
          databaseName: DEFAULT_DATABASE,
          tableName,
          columns: [],
          inputSchema: { type: "object", properties: {}, required: [] },
          message: "",
          error: `Table "${tableName}" already exists in database "${DEFAULT_DATABASE}".\nUse drop_table first if you want to recreate it.`,
        };
      }

      await litesql.createTableAsync(DEFAULT_DATABASE, tableName, columns);

      // Build IColumnInfo from the input columns so we can derive the JSON Schema
      const columnInfos: IColumnInfo[] = columns.map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notNull ?? false,
        primaryKey: c.primaryKey ?? false,
        defaultValue: c.defaultValue ?? null,
      }));

      const inputSchema: IJsonSchema = columnsToJsonSchema(columnInfos);
      const schemaJson: string = JSON.stringify(inputSchema);

      return {
        success: true,
        databaseName: DEFAULT_DATABASE,
        tableName,
        columns: columnInfos,
        inputSchema,
        message:
          `Table "${tableName}" created with columns: ${columns.map((c) => c.name).join(", ")}.\n` +
          `To insert rows, use the tool: write_table_${tableName}\n` +
          `For LITESQL nodes inserting into this table, use this inputSchema (pass as inputSchemaHint to add_litesql_node):\n` +
          schemaJson,
      };
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err);
      logger.error("create-table tool error", { error: errorMsg });
      return {
        success: false,
        databaseName: DEFAULT_DATABASE,
        tableName,
        columns: [],
        inputSchema: { type: "object", properties: {}, required: [] },
        message: "",
        error: errorMsg,
      };
    }
  },
});
