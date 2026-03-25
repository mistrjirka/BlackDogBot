import { tool } from "langchain";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IInsertResult, ITableInfo, IColumnInfo } from "../helpers/litesql.js";

const COMMON_TIMESTAMP_COLUMNS: Set<string> = new Set([
  "created_at",
  "updated_at",
  "timestamp",
  "created",
  "updated",
]);

export const writeToDatabaseTool = tool(
  async ({
    databaseName,
    tableName,
    data,
  }: {
    databaseName: string;
    tableName: string;
    data: Record<string, unknown>[];
  }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    insertedCount: number;
    lastRowId: number;
    message: string;
    error?: string;
  }> => {
    const dbExists: boolean = await litesql.databaseExistsAsync(databaseName);
    if (!dbExists) {
      const allDbs = await litesql.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      return {
        success: false,
        databaseName,
        tableName,
        insertedCount: 0,
        lastRowId: 0,
        message: "",
        error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
      };
    }

    const tableExists: boolean = await litesql.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const allTables: string[] = await litesql.listTablesAsync(databaseName);
      const available: string = allTables.join(", ") || "(none)";

      return {
        success: false,
        databaseName,
        tableName,
        insertedCount: 0,
        lastRowId: 0,
        message: "",
        error: `Table "${tableName}" does not exist in database "${databaseName}".\nAvailable tables: ${available}`,
      };
    }

    // Get table schema for validation and auto-fill
    const schema: ITableInfo = await litesql.getTableSchemaAsync(databaseName, tableName);
    const columnMap: Map<string, IColumnInfo> = new Map(
      schema.columns.map((col) => [col.name, col]),
    );

    // Validate and auto-fill each row
    const enrichedData: Record<string, unknown>[] = [];

    for (const row of data) {
      const enriched: Record<string, unknown> = { ...row };
      const errors: string[] = [];

      // Auto-fill timestamp columns if missing
      for (const col of schema.columns) {
        if (COMMON_TIMESTAMP_COLUMNS.has(col.name) && col.notNull && !col.primaryKey) {
          if (!(col.name in enriched) || enriched[col.name] === null || enriched[col.name] === undefined) {
            enriched[col.name] = new Date().toISOString();
          }
        }
      }

      // Validate provided columns exist in table
      for (const key of Object.keys(enriched)) {
        if (!columnMap.has(key)) {
          errors.push(`Column "${key}" does not exist in table "${tableName}". Available columns: ${schema.columns.map((c) => c.name).join(", ")}`);
        }
      }

      // Validate NOT NULL columns are provided
      for (const col of schema.columns) {
        if (col.notNull && !col.primaryKey && !col.defaultValue) {
          if (!(col.name in enriched) || enriched[col.name] === null || enriched[col.name] === undefined) {
            errors.push(`Column "${col.name}" is required (NOT NULL, no default) but was not provided.`);
          }
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          databaseName,
          tableName,
          insertedCount: 0,
          lastRowId: 0,
          message: "",
          error: `Validation failed for table "${tableName}":\n${errors.join("\n")}\n\nTable schema:\n${schema.columns.map((c) => `  ${c.name} ${c.type}${c.notNull ? " NOT NULL" : ""}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ""}`).join("\n")}`,
        };
      }

      enrichedData.push(enriched);
    }

    const result: IInsertResult = await litesql.insertIntoTableAsync(databaseName, tableName, enrichedData);

    const sampleRow: Record<string, unknown> = enrichedData[0] ?? {};
    const columns: string = Object.keys(sampleRow).join(", ");

    return {
      success: true,
      databaseName,
      tableName,
      insertedCount: result.insertedCount,
      lastRowId: result.lastRowId,
      message: `Inserted ${result.insertedCount} row(s) into "${tableName}" (columns: ${columns}). Last Row ID: ${result.lastRowId}`,
    };
  },
  {
    name: "write_to_database",
    description: "Write a row of data into a table in a database. Prefer per-table tools (write_table_<tableName>) when available — they enforce exact column schemas.",
    schema: z.object({
      databaseName: z.string()
        .min(1)
        .describe("Name of the database to write to"),
      tableName: z.string()
        .min(1)
        .describe("Name of the table to write to"),
      data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .array()
        .min(1)
        .describe("Array of row objects to insert (e.g. [{title: 'Hello', score: 5}]). Values must be flat primitives — no nested objects."),
    }),
  },
);
