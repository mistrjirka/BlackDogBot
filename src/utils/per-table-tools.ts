import { dynamicTool, type ToolSet } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IColumnInfo, ITableInfo } from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "./error.js";
import { createUpdateTableTool } from "../tools/update-table.tool.js";

//#region Constants

const DEFAULT_DATABASE = "blackdog";

const WRITE_TO_TABLE_DESCRIPTION: string =
  "Insert rows into the \"{tableName}\" table. " +
  "USE THIS TOOL whenever you need to write data to the {tableName} table — do NOT use any other tool for database inserts. " +
  "Column names and types are enforced by the schema — only valid columns are accepted. " +
  "Auto-fills created_at, updated_at, and similar timestamp columns if missing. " +
  "Omit auto-increment primary key columns (they are assigned automatically).";

export const SQLITE_TO_ZOD_TYPE: Record<string, z.ZodType> = {
  // Text types
  TEXT: z.string(),
  VARCHAR: z.string(),
  CHAR: z.string(),
  CLOB: z.string(),
  STRING: z.string(),
  // Integer types
  INTEGER: z.number().int(),
  INT: z.number().int(),
  SMALLINT: z.number().int(),
  TINYINT: z.number().int(),
  BIGINT: z.number().int(),
  // Floating point types
  REAL: z.number(),
  FLOAT: z.number(),
  DOUBLE: z.number(),
  NUMERIC: z.number(),
  DECIMAL: z.number(),
  // Binary
  BLOB: z.string(),
  // Boolean
  BOOLEAN: z.union([z.literal(0), z.literal(1), z.boolean()]),
  BOOL: z.union([z.literal(0), z.literal(1), z.boolean()]),
  // Date/time types
  DATE: z.string(),
  DATETIME: z.string(),
  TIMESTAMP: z.string(),
};

export const COMMON_TIMESTAMP_COLUMNS: Set<string> = new Set([
  "created_at",
  "updated_at",
  "timestamp",
  "created",
  "updated",
]);

//#endregion Constants

//#region Public Functions

/**
 * Scans the single default database and creates per-table write tools with exact Zod schemas.
 *
 * For each table found, creates a tool named `write_table_<tableName>` with a
 * Zod schema derived from the table's column definitions. This prevents the
 * model from inserting data with wrong column names or missing required columns.
 */
export async function buildPerTableToolsAsync(): Promise<ToolSet> {
  const logger: LoggerService = LoggerService.getInstance();
  const tools: ToolSet = {};

  let tableNames: string[];
  try {
    tableNames = await litesql.listTablesAsync(DEFAULT_DATABASE);
  } catch (err: unknown) {
    logger.warn("Failed to list tables for per-table tool generation", {
      database: DEFAULT_DATABASE,
      error: extractErrorMessage(err),
    });
    return tools;
  }

  for (const tableName of tableNames) {
    let schema: ITableInfo;
    try {
      schema = await litesql.getTableSchemaAsync(DEFAULT_DATABASE, tableName);
    } catch (err: unknown) {
      logger.warn("Failed to get table schema for per-table tool generation", {
        database: DEFAULT_DATABASE,
        table: tableName,
        error: extractErrorMessage(err),
      });
      continue;
    }

    const perTableTool = _buildWriteToolForTable(DEFAULT_DATABASE, tableName, schema.columns);
    tools[`write_table_${tableName}`] = perTableTool;
  }

  logger.info("Per-table write tools built", {
    database: DEFAULT_DATABASE,
    toolCount: Object.keys(tools).length,
    toolNames: Object.keys(tools),
  });

  return tools;
}

/**
 * Scans the single default database and creates per-table update tools.
 * For each table found, creates a tool named `update_table_<tableName>`.
 */
export async function buildUpdateTableToolsAsync(): Promise<ToolSet> {
  const logger: LoggerService = LoggerService.getInstance();
  const tools: ToolSet = {};

  let tableNames: string[];
  try {
    tableNames = await litesql.listTablesAsync(DEFAULT_DATABASE);
  } catch (err: unknown) {
    logger.warn("Failed to list tables for per-table update tool generation", {
      database: DEFAULT_DATABASE,
      error: extractErrorMessage(err),
    });
    return tools;
  }

  for (const tableName of tableNames) {
    let schema: ITableInfo;
    try {
      schema = await litesql.getTableSchemaAsync(DEFAULT_DATABASE, tableName);
    } catch (err: unknown) {
      logger.warn("Failed to get table schema for per-table update tool generation", {
        database: DEFAULT_DATABASE,
        table: tableName,
        error: extractErrorMessage(err),
      });
      continue;
    }

    tools[`update_table_${tableName}`] = createUpdateTableTool(tableName, schema.columns);
  }

  logger.info("Per-table update tools built", {
    database: DEFAULT_DATABASE,
    toolCount: Object.keys(tools).length,
    toolNames: Object.keys(tools),
  });

  return tools;
}

/**
 * Build both write and update per-table tools for the single database.
 */
export async function buildPerTableToolsWithUpdatesAsync(): Promise<{
  write: ToolSet;
  update: ToolSet;
}> {
  const [writeTools, updateTools] = await Promise.all([
    buildPerTableToolsAsync(),
    buildUpdateTableToolsAsync(),
  ]);

  return { write: writeTools, update: updateTools };
}

/**
 * Build a single per-table write tool for a specific table.
 * Useful for hot-reload after creating a new table.
 */
export function buildSingleTableTool(
  tableName: string,
  columns: IColumnInfo[],
): { name: string; toolInstance: ReturnType<typeof dynamicTool> } {
  const perTableTool = _buildWriteToolForTable(DEFAULT_DATABASE, tableName, columns);
  return {
    name: `write_table_${tableName}`,
    toolInstance: perTableTool,
  };
}

/**
 * Build a single per-table update tool for a specific table.
 * Useful for hot-reload after creating a new table.
 */
export function buildSingleUpdateTableTool(
  tableName: string,
  columns: IColumnInfo[],
): { name: string; toolInstance: ToolSet[string] } {
  return {
    name: `update_table_${tableName}`,
    toolInstance: createUpdateTableTool(tableName, columns),
  };
}

//#endregion Public Functions

//#region Private Functions

function _buildWriteToolForTable(
  _databaseName: string,
  tableName: string,
  columns: IColumnInfo[],
) {
  const description: string = WRITE_TO_TABLE_DESCRIPTION.replace("{tableName}", tableName);

  const dataSchema = _buildZodSchemaForColumns(columns);

  return dynamicTool({
    description,
    inputSchema: z.object({
      data: dataSchema,
    }),
    execute: async (input: unknown): Promise<{
      success: boolean;
      databaseName: string;
      tableName: string;
      insertedCount: number;
      lastRowId: number;
      message: string;
    }> => {
      const { data } = input as { data: Record<string, unknown>[] };
      const timestampColumns: Record<string, string> = {};

      // Auto-fill timestamp columns if missing
      for (const col of columns) {
        if (COMMON_TIMESTAMP_COLUMNS.has(col.name) && col.notNull && !col.primaryKey) {
          timestampColumns[col.name] = new Date().toISOString();
        }
      }

      const enrichedData: Record<string, unknown>[] = data.map((row) => {
        const enriched: Record<string, unknown> = { ...row };

        for (const [colName, defaultValue] of Object.entries(timestampColumns)) {
          if (!(colName in enriched) || enriched[colName] === null || enriched[colName] === undefined) {
            enriched[colName] = defaultValue;
          }
        }

        return enriched;
      });

      const result: litesql.IInsertResult = await litesql.insertIntoTableAsync(
        DEFAULT_DATABASE,
        tableName,
        enrichedData,
      );

      const sampleRow: Record<string, unknown> = enrichedData[0] ?? {};
      const usedColumns: string = Object.keys(sampleRow).join(", ");

      return {
        success: true,
        databaseName: DEFAULT_DATABASE,
        tableName,
        insertedCount: result.insertedCount,
        lastRowId: result.lastRowId,
        message: `Inserted ${result.insertedCount} row(s) into "${tableName}" (columns: ${usedColumns}). Last Row ID: ${result.lastRowId}`,
      };
    },
  });
}

/**
 * Build a Zod schema for the given columns. Exported for testing.
 */
export function buildZodSchemaForColumns(columns: IColumnInfo[]): z.ZodArray<z.ZodObject<Record<string, z.ZodType>>> {
  return _buildZodSchemaForColumns(columns);
}

function _buildZodSchemaForColumns(columns: IColumnInfo[]): z.ZodArray<z.ZodObject<Record<string, z.ZodType>>> {
  const shape: Record<string, z.ZodType> = {};

  for (const col of columns) {
    // Skip auto-increment primary keys
    const isIntegerPk: boolean = col.primaryKey &&
      (col.type.toUpperCase() === "INTEGER" || col.type.toUpperCase() === "INT");

    if (isIntegerPk) {
      continue;
    }

    const normalizedType: string = col.type.toUpperCase().replace(/\(.*\)/, "").trim();
    const baseType = SQLITE_TO_ZOD_TYPE[normalizedType] ?? z.string();

    if (col.notNull && !col.defaultValue) {
      // Required column — no default, NOT NULL
      shape[col.name] = baseType.describe(`${col.type}${col.notNull ? " NOT NULL" : ""}`);
    } else {
      // Optional column — has default or is nullable
      shape[col.name] = baseType.optional().describe(
        `${col.type}${col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ""}${col.notNull ? " NOT NULL" : " NULLABLE"}`,
      );
    }
  }

  return z.object(shape).array().min(1);
}

//#endregion Private Functions
