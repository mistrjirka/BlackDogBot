import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import Database from "better-sqlite3";

import { LoggerService } from "./logger.service.js";
import { getDatabasePath, getDatabasesDir, ensureDirectoryExistsAsync } from "../utils/paths.js";

export interface IDatabaseInfo {
  name: string;
  path: string;
  tableCount: number;
  sizeBytes: number;
  createdAt: string;
}

export interface ITableInfo {
  name: string;
  columns: IColumnInfo[];
}

export interface IColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface IInsertResult {
  insertedCount: number;
  lastRowId: number;
}

export interface IQueryOptions {
  where?: string;
  orderBy?: string;
  limit?: number;
  columns?: string[];
}

export interface IQueryResult {
  rows: Record<string, unknown>[];
  totalCount: number;
}

export class LiteSqlService {
  //#region Data members

  private static _instance: LiteSqlService | null;
  private _logger: LoggerService;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): LiteSqlService {
    if (!LiteSqlService._instance) {
      LiteSqlService._instance = new LiteSqlService();
    }

    return LiteSqlService._instance;
  }

  public async listDatabasesAsync(): Promise<IDatabaseInfo[]> {
    await ensureDirectoryExistsAsync(getDatabasesDir());

    const files: string[] = await fsPromises.readdir(getDatabasesDir());

    const databases: IDatabaseInfo[] = [];

    for (const file of files) {
      if (!file.endsWith(".db")) {
        continue;
      }

      const dbPath: string = path.join(getDatabasesDir(), file);
      const stats = await fsPromises.stat(dbPath);
      const name: string = file.replace(".db", "");

      try {
        const db: Database.Database = new Database(dbPath, { readonly: true });
        const tableCountResult = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number } | undefined;
        db.close();

        databases.push({
          name,
          path: dbPath,
          tableCount: tableCountResult?.count ?? 0,
          sizeBytes: stats.size,
          createdAt: stats.birthtime.toISOString(),
        });
      } catch {
        databases.push({
          name,
          path: dbPath,
          tableCount: 0,
          sizeBytes: stats.size,
          createdAt: stats.birthtime.toISOString(),
        });
      }
    }

    return databases;
  }

  public async listTablesAsync(databaseName: string): Promise<string[]> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const tables: { name: string }[] = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];

      return tables.map((t) => t.name);
    } finally {
      db.close();
    }
  }

  public async getTableSchemaAsync(databaseName: string, tableName: string): Promise<ITableInfo> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const tableExists: { count: number } = db
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tableName) as { count: number };

      if (tableExists.count === 0) {
        throw new Error(`Table "${tableName}" does not exist in database "${databaseName}"`);
      }

      const rawColumns = db
        .prepare(`PRAGMA table_info("${tableName}")`)
        .all() as { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];

      return {
        name: tableName,
        columns: rawColumns.map((col) => ({
          name: col.name,
          type: col.type,
          notNull: col.notnull === 1,
          primaryKey: col.pk === 1,
          defaultValue: col.dflt_value,
        })),
      };
    } finally {
      db.close();
    }
  }

  public async createDatabaseAsync(databaseName: string): Promise<void> {
    const invalidName: RegExp = /[^a-zA-Z0-9_]/;
    if (invalidName.test(databaseName)) {
      throw new Error("Database name must contain only alphanumeric characters and underscores");
    }

    const dbPath: string = getDatabasePath(databaseName);

    try {
      await fsPromises.access(dbPath);
      throw new Error(`Database "${databaseName}" already exists`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await ensureDirectoryExistsAsync(getDatabasesDir());

    const db: Database.Database = new Database(dbPath);
    db.close();

    this._logger.info("Database created", { databaseName, path: dbPath });
  }

  public async createTableAsync(
    databaseName: string,
    tableName: string,
    columns: { name: string; type: string; primaryKey?: boolean; notNull?: boolean; defaultValue?: string }[],
  ): Promise<void> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const columnDefs: string[] = columns.map((col) => {
        let def: string = `"${col.name}" ${col.type.toUpperCase()}`;

        if (col.primaryKey) {
          def += " PRIMARY KEY";
        }

        if (col.notNull && !col.primaryKey) {
          def += " NOT NULL";
        }

        if (col.defaultValue !== undefined) {
          def += ` DEFAULT ${col.defaultValue}`;
        }

        return def;
      });

      const sql: string = `CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefs.join(", ")})`;
      db.exec(sql);

      this._logger.info("Table created", { databaseName, tableName, columns: columns.map((c) => c.name) });
    } finally {
      db.close();
    }
  }

  public async dropTableAsync(databaseName: string, tableName: string): Promise<void> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
      this._logger.info("Table dropped", { databaseName, tableName });
    } finally {
      db.close();
    }
  }

  public async insertIntoTableAsync(
    databaseName: string,
    tableName: string,
    data: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<IInsertResult> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const isArray: boolean = Array.isArray(data);
      const items: Record<string, unknown>[] = isArray ? (data as Record<string, unknown>[]) : [data as Record<string, unknown>];

      if (items.length === 0) {
        return { insertedCount: 0, lastRowId: 0 };
      }

      const columns: string[] = Object.keys(items[0]);
      const placeholders: string = columns.map(() => "?").join(", ");
      const sql: string = `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;

      const insertStmt = db.prepare(sql);
      let lastRowId: number = 0;
      let insertedCount: number = 0;

      const insertMany = db.transaction((rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          const values: unknown[] = columns.map((col) => row[col]);
          const result: Database.RunResult = insertStmt.run(...values);
          lastRowId = Number(result.lastInsertRowid);
          insertedCount++;
        }
      });

      insertMany(items);

      this._logger.debug("Data inserted", { databaseName, tableName, count: insertedCount });

      return { insertedCount, lastRowId };
    } finally {
      db.close();
    }
  }

  public async databaseExistsAsync(databaseName: string): Promise<boolean> {
    const dbPath: string = getDatabasePath(databaseName);

    try {
      await fsPromises.access(dbPath);
      return true;
    } catch {
      return false;
    }
  }

  public async tableExistsAsync(databaseName: string, tableName: string): Promise<boolean> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const result: { count: number } = db
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tableName) as { count: number };

      return result.count > 0;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  public async queryTableAsync(databaseName: string, tableName: string, options?: IQueryOptions): Promise<IQueryResult> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const columnList: string = options?.columns && options.columns.length > 0
        ? options.columns.map((c: string) => `"${c}"`).join(", ")
        : "*";

      let selectSql: string = `SELECT ${columnList} FROM "${tableName}"`;
      let countSql: string = `SELECT COUNT(*) as count FROM "${tableName}"`;

      if (options?.where) {
        selectSql += ` WHERE ${options.where}`;
        countSql += ` WHERE ${options.where}`;
      }

      if (options?.orderBy) {
        selectSql += ` ORDER BY ${options.orderBy}`;
      }

      if (options?.limit !== undefined) {
        selectSql += ` LIMIT ${options.limit}`;
      }

      const rows: Record<string, unknown>[] = db.prepare(selectSql).all() as Record<string, unknown>[];
      const countResult: { count: number } = db.prepare(countSql).get() as { count: number };

      return { rows, totalCount: countResult.count };
    } finally {
      db.close();
    }
  }

  public async updateTableAsync(
    databaseName: string,
    tableName: string,
    set: Record<string, unknown>,
    where: string,
  ): Promise<{ updatedCount: number }> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const tableExists: boolean = await this.tableExistsAsync(databaseName, tableName);
      if (!tableExists) {
        throw new Error(
          `Table "${tableName}" does not exist in database "${databaseName}". ` +
            `Available tables: ${(await this.listTablesAsync(databaseName)).join(", ") || "(none)"}`,
        );
      }

      const setClauses: string[] = Object.keys(set).map((key: string) => `"${key}" = ?`);
      const setValues: unknown[] = Object.values(set);
      const updateSql: string = `UPDATE "${tableName}" SET ${setClauses.join(", ")} WHERE ${where}`;

      this._logger.debug("Executing UPDATE", { databaseName, tableName, set, where, sql: updateSql });

      const result: Database.RunResult = db.prepare(updateSql).run(...setValues);
      const updatedCount: number = result.changes;

      this._logger.debug("Rows updated", { databaseName, tableName, count: updatedCount });

      return { updatedCount };
    } finally {
      db.close();
    }
  }

  public async deleteFromTableAsync(
    databaseName: string,
    tableName: string,
    where: string,
  ): Promise<{ deletedCount: number }> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const tableExists: boolean = await this.tableExistsAsync(databaseName, tableName);
      if (!tableExists) {
        throw new Error(
          `Table "${tableName}" does not exist in database "${databaseName}". ` +
            `Available tables: ${(await this.listTablesAsync(databaseName)).join(", ") || "(none)"}`,
        );
      }

      const deleteSql: string = `DELETE FROM "${tableName}" WHERE ${where}`;

      this._logger.debug("Executing DELETE", { databaseName, tableName, where, sql: deleteSql });

      const result: Database.RunResult = db.prepare(deleteSql).run();
      const deletedCount: number = result.changes;

      this._logger.debug("Rows deleted", { databaseName, tableName, count: deletedCount });

      return { deletedCount };
    } finally {
      db.close();
    }
  }

  //#endregion Public methods

  //#region Private methods

  private _openDatabase(databaseName: string): Database.Database {
    const dbPath: string = getDatabasePath(databaseName);

    if (!fs.existsSync(dbPath)) {
      throw new Error(
        `Database "${databaseName}" does not exist. ` +
          `Available databases: ${this._listDatabaseNamesSync().join(", ") || "(none)"}`,
      );
    }

    return new Database(dbPath);
  }

  private _listDatabaseNamesSync(): string[] {
    if (!fs.existsSync(getDatabasesDir())) {
      return [];
    }

    return fs
      .readdirSync(getDatabasesDir())
      .filter((f: string) => f.endsWith(".db"))
      .map((f: string) => f.replace(".db", ""));
  }

  //#endregion Private methods
}
