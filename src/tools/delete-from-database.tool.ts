import { tool } from "langchain";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import * as litesqlValidation from "../helpers/litesql-validation.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

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

export const deleteFromDatabaseTool = tool(
  async ({
    databaseName,
    tableName,
    where,
  }: {
    databaseName: string;
    tableName: string;
    where: string;
  }): Promise<IDeleteFromDatabaseResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
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

      const result = await litesql.deleteFromTableAsync(databaseName, tableName, where);

      return {
        success: true,
        databaseName,
        tableName,
        deletedCount: result.deletedCount,
      };
    } catch (error: unknown) {
      const errorMsg: string = extractErrorMessage(error);
      logger.error("delete-from-database tool error", { error: errorMsg });
      return {
        success: false,
        databaseName,
        tableName,
        error: errorMsg,
      };
    }
  },
  {
    name: "delete_from_database",
    description:
      "Delete rows from a database table. Requires a WHERE clause to prevent accidental full-table deletes.",
    schema: z.object({
      databaseName: z.string()
        .min(1)
        .describe("Database name (without .db extension)"),
      tableName: z.string()
        .min(1)
        .describe("Table to delete from"),
      where: z.string()
        .min(1)
        .describe("SQL WHERE clause (required for safety, e.g. \"id < 10\")"),
    }),
  },
);

//#endregion Tool
