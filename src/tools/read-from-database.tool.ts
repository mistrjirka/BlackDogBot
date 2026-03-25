import { tool } from "langchain";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IQueryResult } from "../helpers/litesql.js";

export const readFromDatabaseTool = tool(
  async ({
    databaseName,
    tableName,
    where,
    orderBy,
    limit,
    columns,
  }: {
    databaseName: string;
    tableName: string;
    where?: string;
    orderBy?: string;
    limit?: number;
    columns?: string[];
  }): Promise<{
    databaseName: string;
    tableName: string;
    rows: Record<string, unknown>[];
    totalCount: number;
    returnedCount: number;
  }> => {
    const dbExists: boolean = await litesql.databaseExistsAsync(databaseName);
    if (!dbExists) {
      const allDbs = await litesql.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      throw new Error(
        `Database "${databaseName}" does not exist.\n` +
          `Available databases: ${available}`,
      );
    }

    const tableExists: boolean = await litesql.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const allTables: string[] = await litesql.listTablesAsync(databaseName);
      const available: string = allTables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${databaseName}".\n` +
          `Available tables: ${available}`,
      );
    }

    const result: IQueryResult = await litesql.queryTableAsync(databaseName, tableName, {
      where,
      orderBy,
      limit: limit ?? 100,
      columns,
    });

    return {
      databaseName,
      tableName,
      rows: result.rows,
      totalCount: result.totalCount,
      returnedCount: result.rows.length,
    };
  },
  {
    name: "read_from_database",
    description: "Read rows from a table in a database with optional filtering, ordering, and column selection",
    schema: z.object({
      databaseName: z.string()
        .min(1)
        .describe("Name of the database to read from"),
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
  },
);
