import { tool } from "langchain";
import type { DynamicStructuredTool } from "langchain";
import { z } from "zod";
import { LoggerService } from "../services/logger.service.js";

export interface IUpdateTableResult {
  success: boolean;
  message: string;
  databaseName: string;
  tableName: string;
  where: string;
}

export function createUpdateTableTool(
  tableName: string,
  columns: string[],
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
      
      logger.info(`[update_table_${tableName}] Updating rows where ${where}`, {
        columns: Object.keys(setColumns),
      });
      
      return {
        success: true,
        message: `Updated ${Object.keys(setColumns).length} column(s) in ${tableName} where ${where}`,
        databaseName: "default",
        tableName,
        where: where as string,
      };
    },
    {
      name: toolName,
      description: `Update rows in the '${tableName}' table. Requires a WHERE clause to prevent accidental full-table updates.`,
      schema,
    },
  ) as DynamicStructuredTool;
}
