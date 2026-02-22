import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService, IColumnInfo } from "../services/litesql.service.js";
import { columnsToJsonSchema, IJsonSchema } from "../utils/litesql-schema-helper.js";

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
  description: "Create a new table in a database",
  inputSchema: z.object({
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
  execute: async ({
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
    if (tableExists) {
      throw new Error(
        `Table "${tableName}" already exists in database "${databaseName}".\n` +
          `Use drop_table first if you want to recreate it.`,
      );
    }

    await service.createTableAsync(databaseName, tableName, columns);

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
      databaseName,
      tableName,
      columns: columnInfos,
      inputSchema,
      message:
        `Table "${tableName}" created with columns: ${columns.map((c) => c.name).join(", ")}.\n` +
        `For LITESQL nodes inserting into this table, use this inputSchema (pass as inputSchemaHint to add_litesql_node):\n` +
        schemaJson,
    };
  },
});
