import { tool } from "langchain";
import type { DynamicStructuredTool } from "langchain";
import { z } from "zod";
import * as litesql from "../helpers/litesql.js";
import * as litesqlValidation from "../helpers/litesql-validation.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

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
  columns: string[],
  databaseName: string,
): DynamicStructuredTool {
  const logger = LoggerService.getInstance();

  const settableColumns = columns.filter(col => col.toLowerCase() !== "id");

  const columnSchemas: Record<string, z.ZodOptional<z.ZodType<string | number | boolean | null>>> = {};
  for (const col of settableColumns) {
    columnSchemas[col] = z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
    ]).optional().describe(`Value for column '${col}'`);
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
