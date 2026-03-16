import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import * as litesqlValidation from "../helpers/litesql-validation.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

interface IUpdateDatabaseResult {
  success: boolean;
  databaseName: string;
  tableName: string;
  updatedCount?: number;
  error?: string;
}

//#endregion Interfaces

//#region Tool

export const updateDatabaseTool = tool({
  description:
    "Update rows in a database table. Requires a WHERE clause to prevent accidental full-table updates.",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Database name (without .db extension)"),
    tableName: z.string()
      .min(1)
      .describe("Table to update"),
    set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .describe("Column-value pairs to set (e.g. {isInteresting: 1, score: 10}). Values must be flat primitives — no nested objects."),
    where: z.string()
      .min(1)
      .describe("SQL WHERE clause (required for safety, e.g. \"id = 5\")"),
  }),
  execute: async ({
    databaseName,
    tableName,
    set,
    where,
  }: {
    databaseName: string;
    tableName: string;
    set: Record<string, unknown>;
    where: string;
  }): Promise<IUpdateDatabaseResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      if (Object.keys(set).length === 0) {
        return {
          success: false,
          databaseName,
          tableName,
          error: "set must contain at least one column-value pair to update",
        };
      }

      try {
        await litesqlValidation.validateDatabaseExistsAsync(databaseName);
      } catch (error: unknown) {
        return {
          success: false,
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
          databaseName,
          tableName,
          error: extractErrorMessage(error),
        };
      }

      const result = await litesql.updateTableAsync(databaseName, tableName, set, where);

      return {
        success: true,
        databaseName,
        tableName,
        updatedCount: result.updatedCount,
      };
    } catch (error: unknown) {
      const errorMsg: string = extractErrorMessage(error);
      logger.error("update-database tool error", { error: errorMsg });
      return {
        success: false,
        databaseName,
        tableName,
        error: errorMsg,
      };
    }
  },
});

//#endregion Tool
