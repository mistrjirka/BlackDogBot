import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IQueryResult } from "../helpers/litesql.js";

const DEFAULT_DATABASE = "blackdog";

export const readFromDatabaseTool = tool({
  description: "Read rows from a table in the default database with optional filtering, ordering, and column selection",
  inputSchema: z.object({
    tableName: z.string()
      .min(1)
      .describe("Name of the table to read from"),
    where: z.string()
      .describe("SQL WHERE clause to filter rows (e.g. \"isInteresting = 1 AND pubDate > '2024-01-01'\")")
      .optional(),
    orderBy: z.string()
      .describe("SQL ORDER BY clause to sort rows (e.g. \"pubDate DESC\")")
      .optional(),
    limit: z.number()
      .int()
      .positive()
      .describe("Maximum number of rows to return (default 100)")
      .optional(),
    columns: z.string()
      .array()
      .describe("Specific columns to select (defaults to all columns)")
      .optional(),
  }),
  execute: async ({
    tableName,
    where,
    orderBy,
    limit,
    columns,
  }: {
    tableName: string;
    where?: string;
    orderBy?: string;
    limit?: number;
    columns?: string[];
  }): Promise<{
    tableName: string;
    rows: Record<string, unknown>[];
    totalCount: number;
    returnedCount: number;
  }> => {
    const dbExists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
    if (!dbExists) {
      throw new Error(
        "Internal database is not initialized.",
      );
    }

    const tableExists: boolean = await litesql.tableExistsAsync(DEFAULT_DATABASE, tableName);
    if (!tableExists) {
      const allTables: string[] = await litesql.listTablesAsync(DEFAULT_DATABASE);
      const available: string = allTables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${DEFAULT_DATABASE}".\n` +
          `Available tables: ${available}`,
      );
    }

    const result: IQueryResult = await litesql.queryTableAsync(DEFAULT_DATABASE, tableName, {
      where,
      orderBy,
      limit: limit ?? 100,
      columns,
    });

    return {
      tableName,
      rows: result.rows,
      totalCount: result.totalCount,
      returnedCount: result.rows.length,
    };
  },
});
