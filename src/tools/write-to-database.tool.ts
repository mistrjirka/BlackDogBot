import { tool } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IInsertResult } from "../helpers/litesql.js";

export const writeToDatabaseTool = tool({
  description: "Write a row of data into a table in a database",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database to write to"),
    tableName: z.string()
      .min(1)
      .describe("Name of the table to write to"),
    data: z.record(z.string(), z.unknown())
      .array()
      .min(1)
      .describe("Array of row objects to insert (e.g. [{title: 'Hello', score: 5}])"),
  }),
  execute: async ({
    databaseName,
    tableName,
    data,
  }: {
    databaseName: string;
    tableName: string;
    data: Record<string, unknown>[];
  }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    insertedCount: number;
    lastRowId: number;
    message: string;
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

    const result: IInsertResult = await litesql.insertIntoTableAsync(databaseName, tableName, data);

    const sampleRow: Record<string, unknown> = data[0] ?? {};
    const columns: string = Object.keys(sampleRow).join(", ");

    return {
      success: true,
      databaseName,
      tableName,
      insertedCount: result.insertedCount,
      lastRowId: result.lastRowId,
      message: `Inserted ${result.insertedCount} row(s) into "${tableName}" (columns: ${columns}). Last Row ID: ${result.lastRowId}`,
    };
  },
});
