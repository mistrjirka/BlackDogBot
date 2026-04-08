import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import * as litesqlValidation from "../helpers/litesql-validation.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

const DEFAULT_DATABASE = "blackdog";

//#region Interfaces

interface IDeleteFromDatabaseResult {
  success: boolean;
  databaseName: string;
  tableName: string;
  deletedCount?: number;
  error?: string;
}

//#endregion Interfaces

//#region Tool

export const deleteFromDatabaseTool = tool({
  description:
    "Delete rows from a database table in the default database. Requires a WHERE clause to prevent accidental full-table deletes.",
  inputSchema: z.object({
    tableName: z.string()
      .min(1)
      .describe("Table to delete from"),
    where: z.string()
      .min(1)
      .describe("SQL WHERE clause (required for safety, e.g. \"id < 10\")"),
  }),
  execute: async ({
    tableName,
    where,
  }: {
    tableName: string;
    where: string;
  }): Promise<IDeleteFromDatabaseResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      try {
        await litesqlValidation.validateDatabaseExistsAsync(DEFAULT_DATABASE);
      } catch (error: unknown) {
        return {
          success: false,
          databaseName: DEFAULT_DATABASE,
          tableName,
          error: extractErrorMessage(error),
        };
      }

      try {
        await litesqlValidation.validateTableExistsAsync(DEFAULT_DATABASE, tableName);
      } catch (error: unknown) {
        return {
          success: false,
          databaseName: DEFAULT_DATABASE,
          tableName,
          error: extractErrorMessage(error),
        };
      }

      const result = await litesql.deleteFromTableAsync(DEFAULT_DATABASE, tableName, where);

      return {
        success: true,
        databaseName: DEFAULT_DATABASE,
        tableName,
        deletedCount: result.deletedCount,
      };
    } catch (error: unknown) {
      const errorMsg: string = extractErrorMessage(error);
      logger.error("delete-from-database tool error", { error: errorMsg });
      return {
        success: false,
        databaseName: DEFAULT_DATABASE,
        tableName,
        error: errorMsg,
      };
    }
  },
});

//#endregion Tool
