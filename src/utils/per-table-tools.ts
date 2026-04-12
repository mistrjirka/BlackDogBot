import { dynamicTool, type ToolSet } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { DatabaseStatus, IColumnInfo } from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { createUpdateTableTool } from "../tools/update-table.tool.js";

import {
  COMMON_TIMESTAMP_COLUMNS,
  DATE_LIKE_TYPES,
  SQLITE_TO_ZOD_TYPE,
} from "./sqlite-type-mappings.js";

const DEFAULT_DATABASE = "blackdog";

const WRITE_TO_TABLE_DESCRIPTION: string =
  "Insert rows into the \"{tableName}\" table. " +
  "USE THIS TOOL whenever you need to write data to the {tableName} table — do NOT use any other tool for database inserts. " +
  "Column names and types are enforced by the schema — only valid columns are accepted. " +
  "All required non-primary-key fields must be provided. " +
  "Date-like fields accept the literal 'now', which is converted to the current ISO timestamp. " +
  "Auto-fills required date-like columns if missing. " +
  "Omit auto-increment primary key columns (they are assigned automatically).";

export interface IPerTableToolsResult {
  tools: ToolSet;
  dbStatus: DatabaseStatus;
}

//#region Public Functions

/**
 * Scans the single default database and creates per-table write tools with exact Zod schemas.
 *
 * For each table found, creates a tool named `write_table_<tableName>` with a
 * Zod schema derived from the table's column definitions. This prevents the
 * model from inserting data with wrong column names or missing required columns.
 */
export async function buildPerTableToolsAsync(): Promise<IPerTableToolsResult> {
  const logger: LoggerService = LoggerService.getInstance();
  const tools: ToolSet = {};

  const listResult = await litesql.safeListTablesAsync(DEFAULT_DATABASE);

  if (listResult.status === "missing") {
    logger.debug("Database not found for per-table write tool generation, returning empty tools", {
      database: DEFAULT_DATABASE,
    });
    return { tools, dbStatus: "missing" };
  }

  if (listResult.status === "corrupt") {
    logger.error("Database is corrupt for per-table write tool generation, returning empty tools", {
      database: DEFAULT_DATABASE,
    });
    return { tools, dbStatus: "corrupt" };
  }

  const tableNames = listResult.tables;

  for (const tableName of tableNames) {
    const schemaResult = await litesql.safeGetTableSchemaAsync(DEFAULT_DATABASE, tableName);

    if (schemaResult.status === "corrupt") {
      logger.error("Database became corrupt during per-table write tool generation", {
        database: DEFAULT_DATABASE,
        table: tableName,
      });
      return { tools, dbStatus: "corrupt" };
    }

    if (schemaResult.status === "missing") {
      logger.warn("Table disappeared between list and schema call", {
        database: DEFAULT_DATABASE,
        table: tableName,
      });
      continue;
    }

    const perTableTool = _buildWriteToolForTable(DEFAULT_DATABASE, tableName, schemaResult.schema!.columns);
    tools[`write_table_${tableName}`] = perTableTool;
  }

  logger.info("Per-table write tools built", {
    database: DEFAULT_DATABASE,
    toolCount: Object.keys(tools).length,
    toolNames: Object.keys(tools),
  });

  return { tools, dbStatus: "ok" };
}

/**
 * Scans the single default database and creates per-table update tools.
 * For each table found, creates a tool named `update_table_<tableName>`.
 */
export async function buildUpdateTableToolsAsync(): Promise<IPerTableToolsResult> {
  const logger: LoggerService = LoggerService.getInstance();
  const tools: ToolSet = {};

  const listResult = await litesql.safeListTablesAsync(DEFAULT_DATABASE);

  if (listResult.status === "missing") {
    logger.debug("Database not found for per-table update tool generation, returning empty tools", {
      database: DEFAULT_DATABASE,
    });
    return { tools, dbStatus: "missing" };
  }

  if (listResult.status === "corrupt") {
    logger.error("Database is corrupt for per-table update tool generation, returning empty tools", {
      database: DEFAULT_DATABASE,
    });
    return { tools, dbStatus: "corrupt" };
  }

  const tableNames = listResult.tables;

  for (const tableName of tableNames) {
    const schemaResult = await litesql.safeGetTableSchemaAsync(DEFAULT_DATABASE, tableName);

    if (schemaResult.status === "corrupt") {
      logger.error("Database became corrupt during per-table update tool generation", {
        database: DEFAULT_DATABASE,
        table: tableName,
      });
      return { tools, dbStatus: "corrupt" };
    }

    if (schemaResult.status === "missing") {
      logger.warn("Table disappeared between list and schema call", {
        database: DEFAULT_DATABASE,
        table: tableName,
      });
      continue;
    }

    tools[`update_table_${tableName}`] = createUpdateTableTool(tableName, schemaResult.schema!.columns);
  }

  logger.info("Per-table update tools built", {
    database: DEFAULT_DATABASE,
    toolCount: Object.keys(tools).length,
    toolNames: Object.keys(tools),
  });

  return { tools, dbStatus: "ok" };
}

/**
 * Build both write and update per-table tools for the single database.
 */
export async function buildPerTableToolsWithUpdatesAsync(): Promise<{
  write: IPerTableToolsResult;
  update: IPerTableToolsResult;
}> {
  const [writeResult, updateResult] = await Promise.all([
    buildPerTableToolsAsync(),
    buildUpdateTableToolsAsync(),
  ]);

  return { write: writeResult, update: updateResult };
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
      tableName: string;
      insertedCount: number;
      lastRowId: number;
      message: string;
    }> => {
      const { data } = input as { data: Record<string, unknown>[] };
      const timestampColumns: Record<string, string> = {};

      // Auto-fill timestamp columns if missing
      for (const col of columns) {
        if (_isDateLikeColumn(col) && col.notNull && !col.primaryKey) {
          timestampColumns[col.name] = new Date().toISOString();
        }
      }

      const enrichedData: Record<string, unknown>[] = data.map((row) => {
        const enriched: Record<string, unknown> = { ...row };

        for (const col of columns) {
          if (!Object.prototype.hasOwnProperty.call(enriched, col.name)) {
            continue;
          }

          const value: unknown = enriched[col.name];
          if (_isDateLikeColumn(col) && typeof value === "string" && value.trim().toLowerCase() === "now") {
            enriched[col.name] = new Date().toISOString();
          }
        }

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

    if (col.notNull && !_isDateLikeColumn(col)) {
      shape[col.name] = baseType.describe(`${col.type} NOT NULL`);
    } else {
      const dateNowHint: string = _isDateLikeColumn(col)
        ? " (accepts 'now' for current ISO timestamp)"
        : "";
      shape[col.name] = baseType.optional().describe(
        `${col.type}${col.notNull ? " NOT NULL" : " NULLABLE"}${dateNowHint}`,
      );
    }
  }

  return z.object(shape).array().min(1);
}

function _isDateLikeColumn(col: IColumnInfo): boolean {
  const normalizedName: string = col.name.toLowerCase();
  const normalizedType: string = col.type.toUpperCase().replace(/\(.*\)/, "").trim();
  return COMMON_TIMESTAMP_COLUMNS.has(normalizedName) || DATE_LIKE_TYPES.has(normalizedType);
}

//#endregion Private Functions
