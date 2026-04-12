import { dynamicTool, type ToolSet } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IColumnInfo } from "../helpers/litesql.js";
import * as litesqlValidation from "../helpers/litesql-validation.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { SQLITE_TO_ZOD_TYPE, isDateLikeColumn } from "../utils/sqlite-type-mappings.js";

const DEFAULT_DATABASE = "blackdog";

export interface IUpdateTableResult {
  success: boolean;
  tableName: string;
  updatedCount?: number;
  message: string;
  error?: string;
}

export function createUpdateTableTool(
  tableName: string,
  columns: IColumnInfo[],
): ToolSet[string] {
  const logger = LoggerService.getInstance();

  const settableColumns = columns.filter(
    (col) => col.name.toLowerCase() !== "id" && !col.primaryKey,
  );

  const columnSchemas: Record<string, z.ZodType> = {};
  for (const col of settableColumns) {
    const normalizedType: string = col.type.toUpperCase().replace(/\(.*\)/, "").trim();
    const baseType = SQLITE_TO_ZOD_TYPE[normalizedType] ?? z.string();
    const isDateLike: boolean = isDateLikeColumn(col);
    const dateNowHint: string = isDateLike ? " (accepts 'now' for current ISO timestamp)" : "";
    const typeDescription = `${col.type}${col.notNull ? " NOT NULL" : " NULLABLE"}${dateNowHint}`;
    columnSchemas[col.name] = baseType.optional().describe(`Value for column '${col.name}' (${typeDescription})`);
  }

  const inputSchema = z.object({
    where: z.string().min(1).describe("SQL WHERE clause (required for safety, e.g. 'id = 5')"),
    ...columnSchemas,
  }).refine(
    (data: Record<string, unknown>) => {
      const cols = Object.keys(data).filter((k) => k !== "where");
      return cols.some((col) => data[col] !== undefined);
    },
    { message: "At least one column must be set" },
  );

  const dateLikeColumns: Set<string> = new Set(
    settableColumns.filter(isDateLikeColumn).map((col) => col.name),
  );

  return dynamicTool({
    description: `Update rows in the '${tableName}' table. Requires a WHERE clause to prevent accidental full-table updates.`,
    inputSchema,
    execute: async (input: unknown): Promise<IUpdateTableResult> => {
      const params = input as Record<string, unknown>;
      const { where, ...setParams } = params;

      const setColumns: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(setParams)) {
        if (value !== undefined) {
          if (typeof value === "string" && value.trim().toLowerCase() === "now" && dateLikeColumns.has(key)) {
            setColumns[key] = new Date().toISOString();
          } else {
            setColumns[key] = value;
          }
        }
      }

      try {
        try {
          await litesqlValidation.validateTableExistsAsync(DEFAULT_DATABASE, tableName);
        } catch (error: unknown) {
          return {
            success: false,
            tableName,
            message: extractErrorMessage(error),
            error: extractErrorMessage(error),
          };
        }

        const result = await litesql.updateTableAsync(DEFAULT_DATABASE, tableName, setColumns, where as string);

        logger.info(`[update_table_${tableName}] Updated ${result.updatedCount} row(s) in ${tableName} where ${where}`, {
          columns: Object.keys(setColumns),
          updatedCount: result.updatedCount,
        });

        return {
          success: true,
          tableName,
          updatedCount: result.updatedCount,
          message: `Updated ${Object.keys(setColumns).length} column(s) in ${tableName} where ${where}. ${result.updatedCount} row(s) affected.`,
        };
      } catch (error: unknown) {
        const errorMsg = extractErrorMessage(error);
        logger.error(`[update_table_${tableName}] Error updating table`, { error: errorMsg });
        return {
          success: false,
          tableName,
          message: errorMsg,
          error: errorMsg,
        };
      }
    },
  });
}
