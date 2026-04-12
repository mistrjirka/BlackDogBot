import * as litesql from "./litesql.js";

//#region Public Functions

export async function validateDatabaseExistsAsync(databaseName: string): Promise<void> {
  const exists: boolean = await litesql.databaseExistsAsync(databaseName);

  if (!exists) {
    throw new Error("Internal database is not initialized.");
  }
}

export async function validateTableExistsAsync(databaseName: string, tableName: string): Promise<void> {
  await validateDatabaseExistsAsync(databaseName);

  const exists: boolean = await litesql.tableExistsAsync(databaseName, tableName);

  if (!exists) {
    const tables = await litesql.listTablesAsync(databaseName);
    const available: string = tables.join(", ") || "(none)";

    throw new Error(`Table "${tableName}" does not exist in database "${databaseName}".\nAvailable tables: ${available}`);
  }
}

export async function getAvailableDatabasesAsync(): Promise<string> {
  const allDbs = await litesql.listDatabasesAsync();

  return allDbs.map((d) => d.name).join(", ") || "(none)";
}

export async function getAvailableTablesAsync(databaseName: string): Promise<string> {
  const tables = await litesql.listTablesAsync(databaseName);

  return tables.join(", ") || "(none)";
}

//#endregion Public Functions
