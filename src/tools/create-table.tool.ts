import { tool } from "langchain";
import type { DynamicStructuredTool } from "langchain";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IColumnInfo } from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { columnsToJsonSchema, IJsonSchema } from "../utils/litesql-schema-helper.js";
import { createUpdateTableTool } from "./update-table.tool.js";

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
    .refine((val) => val === undefined || val.trim().length > 0, {
      message: "Default value cannot be empty string",
    })
    .describe("Default value for the column"),
});

export const createTableTool = tool(
  async ({
    databaseName,
    tableName,
    columns,
  }: {
    databaseName: string;
    tableName: string;
    columns: z.infer<typeof columnDefinitionSchema>[];
  }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    columns: IColumnInfo[];
    inputSchema: IJsonSchema;
    message: string;
    updateTool?: DynamicStructuredTool;
    error?: string;
  }> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const exists: boolean = await litesql.databaseExistsAsync(databaseName);
      if (!exists) {
        const allDbs = await litesql.listDatabasesAsync();
        const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

        return {
          success: false,
          databaseName,
          tableName,
          columns: [],
          inputSchema: { type: "object", properties: {}, required: [] },
          message: "",
          error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
        };
      }

      const tableExists: boolean = await litesql.tableExistsAsync(databaseName, tableName);
      if (tableExists) {
        return {
          success: false,
          databaseName,
          tableName,
          columns: [],
          inputSchema: { type: "object", properties: {}, required: [] },
          message: "",
          error: `Table "${tableName}" already exists in database "${databaseName}".\nUse drop_table first if you want to recreate it.`,
        };
      }

      await litesql.createTableAsync(databaseName, tableName, columns);

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

      const updateTool: DynamicStructuredTool = createUpdateTableTool(
        tableName,
        columnInfos.map((c) => c.name),
        databaseName,
      );

      return {
        success: true,
        databaseName,
        tableName,
        columns: columnInfos,
        inputSchema,
        message:
          `Table "${tableName}" created with columns: ${columns.map((c) => c.name).join(", ")}.\n` +
          `To insert rows, use the tool: write_table_${tableName}\n` +
          `To update rows, use the tool: update_table_${tableName}\n` +
          `For LITESQL nodes inserting into this table, use this inputSchema (pass as inputSchemaHint to add_litesql_node):\n` +
          schemaJson,
        updateTool,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("create-table tool error", { error: errorMsg });
      return {
        success: false,
        databaseName,
        tableName,
        columns: [],
        inputSchema: { type: "object", properties: {}, required: [] },
        message: "",
        error: errorMsg,
      };
    }
  },
  {
    name: "create_table",
    description: "Create a new table in a database. Call this after prerequisite checks/tool calls are complete for the current run.",
    schema: z.object({
      databaseName: z.string()
        .min(1)
        .describe("Name of the database"),
      tableName: z.string()
        .min(1)
        .describe("Name of the table to create"),
      columns: columnDefinitionSchema
        .array()
        .min(1)
        .describe("Array of column definitions"),
    }),
  },
);
