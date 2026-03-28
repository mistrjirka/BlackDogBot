import { tool } from "langchain";
import type { DynamicStructuredTool } from "langchain";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IColumnInfo, ITableInfo } from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";

//#region Constants

const WRITE_TO_TABLE_DESCRIPTION: string =
  "Insert rows into the \"{tableName}\" table in database \"{databaseName}\". " +
  "USE THIS TOOL whenever you need to write data to the {tableName} table — do NOT use any other tool for database inserts. " +
  "Column names and types are enforced by the schema — only valid columns are accepted. " +
  "Auto-fills created_at, updated_at, and similar timestamp columns if missing. " +
  "Omit auto-increment primary key columns (they are assigned automatically).";

const SQLITE_TO_ZOD_TYPE: Record<string, z.ZodType> = {
  TEXT: z.string(),
  VARCHAR: z.string(),
  CHAR: z.string(),
  CLOB: z.string(),
  STRING: z.string(),
  INTEGER: z.number().int(),
  INT: z.number().int(),
  SMALLINT: z.number().int(),
  TINYINT: z.number().int(),
  BIGINT: z.number().int(),
  REAL: z.number(),
  FLOAT: z.number(),
  DOUBLE: z.number(),
  NUMERIC: z.number(),
  DECIMAL: z.number(),
  BLOB: z.string(),
  BOOLEAN: z.union([z.literal(0), z.literal(1), z.boolean()]),
  BOOL: z.union([z.literal(0), z.literal(1), z.boolean()]),
  DATE: z.string(),
  DATETIME: z.string(),
  TIMESTAMP: z.string(),
};

const COMMON_TIMESTAMP_COLUMNS: Set<string> = new Set([
  "created_at",
  "updated_at",
  "timestamp",
  "created",
  "updated",
]);

//#endregion Constants

//#region Public Functions

/**
 * Scans all databases and creates per-table write tools with exact Zod schemas.
 *
 * For each table found, creates a tool named `write_table_<tableName>` with a
 * Zod schema derived from the table's column definitions. This prevents the
 * model from inserting data with wrong column names or missing required columns.
 */
export async function buildPerTableToolsAsync(): Promise<Record<string, DynamicStructuredTool>> {
  const logger: LoggerService = LoggerService.getInstance();
  const tools: Record<string, DynamicStructuredTool> = {};

  const databases: litesql.IDatabaseInfo[] = await litesql.listDatabasesAsync();

  for (const db of databases) {
    let tableNames: string[];

    try {
      tableNames = await litesql.listTablesAsync(db.name);
    } catch (err: unknown) {
      logger.warn("Failed to list tables for per-table tool generation", {
        database: db.name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const tableName of tableNames) {
      let schema: ITableInfo;

      try {
        schema = await litesql.getTableSchemaAsync(db.name, tableName);
      } catch (err: unknown) {
        logger.warn("Failed to get table schema for per-table tool generation", {
          database: db.name,
          table: tableName,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const perTableTool = _buildWriteToolForTable(db.name, tableName, schema.columns);
      const toolName = `write_table_${tableName}`;

      if (toolName in tools) {
        let prefixedName = `write_table_${db.name}_${tableName}`;

        if (prefixedName in tools) {
          let suffix = 2;
          while (`${prefixedName}_${suffix}` in tools) {
            suffix++;
          }
          prefixedName = `${prefixedName}_${suffix}`;
        }

        perTableTool.name = prefixedName;
        tools[prefixedName] = perTableTool;
        logger.debug("Per-table tool name collision, using prefixed name", {
          original: toolName,
          prefixed: prefixedName,
          database: db.name,
        });
      } else {
        tools[toolName] = perTableTool;
      }
    }
  }

  logger.info("Per-table write tools built", {
    toolCount: Object.keys(tools).length,
    toolNames: Object.keys(tools),
  });

  return tools;
}

/**
 * Build a single per-table write tool for a specific table.
 * Useful for hot-reload after creating a new table.
 */
export function buildSingleTableTool(
  databaseName: string,
  tableName: string,
  columns: IColumnInfo[],
): { name: string; toolInstance: DynamicStructuredTool } {
  const perTableTool = _buildWriteToolForTable(databaseName, tableName, columns);
  return {
    name: `write_table_${tableName}`,
    toolInstance: perTableTool,
  };
}

//#endregion Public Functions

//#region Private Functions

function _buildWriteToolForTable(
  databaseName: string,
  tableName: string,
  columns: IColumnInfo[],
): DynamicStructuredTool {
  const description: string = WRITE_TO_TABLE_DESCRIPTION
    .replace("{tableName}", tableName)
    .replace("{databaseName}", databaseName);

  const dataSchema = _buildZodSchemaForColumns(columns);

  return tool(
    async (input: { data: Record<string, unknown>[] }): Promise<{
      success: boolean;
      databaseName: string;
      tableName: string;
      insertedCount: number;
      lastRowId: number;
      message: string;
    }> => {
      const { data } = input;
      const timestampColumns: Record<string, string> = {};

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
        databaseName,
        tableName,
        enrichedData,
      );

      const sampleRow: Record<string, unknown> = enrichedData[0] ?? {};
      const usedColumns: string = Object.keys(sampleRow).join(", ");

      return {
        success: true,
        databaseName,
        tableName,
        insertedCount: result.insertedCount,
        lastRowId: result.lastRowId,
        message: `Inserted ${result.insertedCount} row(s) into "${tableName}" (columns: ${usedColumns}). Last Row ID: ${result.lastRowId}`,
      };
    },
    {
      name: `write_table_${tableName}`,
      description,
      schema: z.object({
        data: dataSchema,
      }),
    },
  );
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
    const isIntegerPk: boolean = col.primaryKey &&
      (col.type.toUpperCase() === "INTEGER" || col.type.toUpperCase() === "INT");

    if (isIntegerPk) {
      continue;
    }

    const normalizedType: string = col.type.toUpperCase().replace(/\(.*\)/, "").trim();
    const baseType = SQLITE_TO_ZOD_TYPE[normalizedType] ?? z.string();

    if (col.notNull && !col.defaultValue) {
      shape[col.name] = baseType.describe(`${col.type}${col.notNull ? " NOT NULL" : ""}`);
    } else {
      shape[col.name] = baseType.optional().describe(
        `${col.type}${col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ""}${col.notNull ? " NOT NULL" : " NULLABLE"}`,
      );
    }
  }

  return z.object(shape).array().min(1);
}

//#endregion Private Functions
