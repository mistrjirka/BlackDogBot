import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";
import { type IInsertResult } from "../services/litesql.service.js";

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
      .describe("The row data to insert, where keys are column names and values are cell values"),
  }),
  execute: async ({
    databaseName,
    tableName,
    data,
  }: {
    databaseName: string;
    tableName: string;
    data: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    insertedCount: number;
    lastRowId: number;
    message: string;
  }> => {
    const service: LiteSqlService = LiteSqlService.getInstance();

    const dbExists: boolean = await service.databaseExistsAsync(databaseName);
    if (!dbExists) {
      const allDbs = await service.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      throw new Error(
        `Database "${databaseName}" does not exist.\n` +
          `Available databases: ${available}`,
      );
    }

    const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const allTables: string[] = await service.listTablesAsync(databaseName);
      const available: string = allTables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${databaseName}".\n` +
          `Available tables: ${available}`,
      );
    }

    const result: IInsertResult = await service.insertIntoTableAsync(databaseName, tableName, data);

    const columns: string = Object.keys(data).join(", ");

    return {
      success: true,
      databaseName,
      tableName,
      insertedCount: result.insertedCount,
      lastRowId: result.lastRowId,
      message: `Inserted 1 row into "${tableName}" (columns: ${columns}). Row ID: ${result.lastRowId}`,
    };
  },
});
