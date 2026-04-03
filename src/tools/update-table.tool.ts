import { tool } from "langchain";
import type { DynamicStructuredTool } from "langchain";
import { z } from "zod";
import * as litesql from "../helpers/litesql.js";
import type { IColumnInfo } from "../helpers/litesql.js";
import * as litesqlValidation from "../helpers/litesql-validation.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { SQLITE_TO_ZOD_TYPE } from "../utils/per-table-tools.js";

export interface IUpdateTableResult {
  success: boolean;
  message: string;
  databaseName: string;
  tableName: string;
  updatedCount?: number;
  error?: string;
}

export function createUpdateTableTool(
  tableName: string,
  columns: IColumnInfo[],
  databaseName: string,
): DynamicStructuredTool {
  const logger = LoggerService.getInstance();

  const settableColumns = columns.filter(col => col.name.toLowerCase() !== "id" && !col.primaryKey);

  const columnSchemas: Record<string, z.ZodType> = {};
  for (const col of settableColumns) {
    const normalizedType: string = col.type.toUpperCase().replace(/\(.*\)/, "").trim();
    const baseType = SQLITE_TO_ZOD_TYPE[normalizedType] ?? z.string();
    const typeDescription = `${col.type}${col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ""}${col.notNull ? " NOT NULL" : " NULLABLE"}`;
    columnSchemas[col.name] = baseType.optional().describe(`Value for column '${col.name}' (${typeDescription})`);
  }

  const baseSchema = z.object({
    where: z.string()
      .min(1)
      .describe("SQL WHERE clause (required for safety, e.g. \"id = 5\")"),
    ...columnSchemas,
  });

  const schema = baseSchema.refine(
    (data: Record<string, unknown>) => {
      const cols = Object.keys(data).filter(k => k !== "where");
      return cols.some(col => data[col] !== undefined);
    },
    { message: "At least one column must be set" },
  );

  const toolName = `update_table_${tableName}`;

  return tool(
    async (params: Record<string, unknown>): Promise<IUpdateTableResult> => {
      const { where, ...setParams } = params;

      const setColumns: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(setParams)) {
        if (value !== undefined) {
          setColumns[key] = value;
        }
      }

      try {
        try {
          await litesqlValidation.validateDatabaseExistsAsync(databaseName);
        } catch (error: unknown) {
          return {
            success: false,
            message: extractErrorMessage(error),
            databaseName,
            tableName,
            error: extractErrorMessage(error),
          };
        }

        try {
          await litesqlValidation.validateTableExistsAsync(databaseName, tableName);
        } catch (error: unknown) {
          return {
            success: false,
            message: extractErrorMessage(error),
            databaseName,
            tableName,
            error: extractErrorMessage(error),
          };
        }

        const result = await litesql.updateTableAsync(databaseName, tableName, setColumns, where as string);

        logger.info(`[update_table_${tableName}] Updated ${result.updatedCount} row(s) in ${tableName} where ${where}`, {
          databaseName,
          columns: Object.keys(setColumns),
          updatedCount: result.updatedCount,
        });

        return {
          success: true,
          message: `Updated ${Object.keys(setColumns).length} column(s) in ${tableName} where ${where}. ${result.updatedCount} row(s) affected.`,
          databaseName,
          tableName,
          updatedCount: result.updatedCount,
        };
      } catch (error: unknown) {
        const errorMsg = extractErrorMessage(error);
        logger.error(`[update_table_${tableName}] Error updating table`, { error: errorMsg });
        return {
          success: false,
          message: errorMsg,
          databaseName,
          tableName,
          error: errorMsg,
        };
      }
    },
    {
      name: toolName,
      description: `Update rows in the '${tableName}' table. Requires a WHERE clause to prevent accidental full-table updates.`,
      schema,
    },
  ) as DynamicStructuredTool;
}
