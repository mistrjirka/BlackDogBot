import { connect, Connection, Table } from "@lancedb/lancedb";

import { getLanceDbDir, ensureDirectoryExistsAsync } from "../utils/paths.js";
import { EMBEDDING_DIMENSION } from "../shared/constants.js";

//#region Interfaces

export interface IVectorRecord {
  id: string;
  content: string;
  collection: string;
  vector: number[];
  metadata: string;
  createdAt: string;
  updatedAt: string;
}

export interface IVectorSearchResult {
  id: string;
  content: string;
  collection: string;
  metadata: string;
  score: number;
}

//#endregion Interfaces

//#region Constants

const DEFAULT_TABLE_NAME: string = "knowledge";

//#endregion Constants

export class VectorStoreService {
  //#region Data members

  private static _instance: VectorStoreService | null;
  private _connection: Connection | null;
  private _tables: Map<string, Table>;
  private _dbPath: string;
  private _embeddingDimension: number;
  private _initialized: boolean;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._connection = null;
    this._tables = new Map<string, Table>();
    this._dbPath = "";
    this._embeddingDimension = EMBEDDING_DIMENSION;
    this._initialized = false;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): VectorStoreService {
    if (!VectorStoreService._instance) {
      VectorStoreService._instance = new VectorStoreService();
    }

    return VectorStoreService._instance;
  }

  public isInitialized(): boolean {
    return this._initialized;
  }

  public async initializeAsync(
    dbPath?: string,
    embeddingDimension?: number,
  ): Promise<void> {
    this._dbPath = dbPath ?? getLanceDbDir();
    this._embeddingDimension = embeddingDimension ?? EMBEDDING_DIMENSION;

    await ensureDirectoryExistsAsync(this._dbPath);

    this._connection = await connect(this._dbPath);
    this._initialized = true;
  }

  public async ensureTableAsync(tableName?: string): Promise<Table> {
    this._ensureInitialized();

    const name: string = tableName ?? DEFAULT_TABLE_NAME;

    const cached: Table | undefined = this._tables.get(name);

    if (cached) {
      return cached;
    }

    const existingNames: string[] = await this._connection!.tableNames();
    let table: Table;

    if (existingNames.includes(name)) {
      table = await this._connection!.openTable(name);
    } else {
      const seedRecord: IVectorRecord = {
        id: "__seed__",
        content: "",
        collection: "__seed__",
        vector: new Array(this._embeddingDimension).fill(0) as number[],
        metadata: "{}",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      table = await this._connection!.createTable(
        name,
        [{ ...seedRecord }],
        { mode: "create", existOk: true },
      );

      await table.delete("id = '__seed__'");
    }

    this._tables.set(name, table);

    return table;
  }

  public async addAsync(
    records: IVectorRecord[],
    tableName?: string,
  ): Promise<void> {
    const table: Table = await this.ensureTableAsync(tableName);

    await table.add(records.map((r: IVectorRecord) => ({ ...r })));
  }

  public async searchAsync(
    queryVector: number[],
    limit: number,
    collectionFilter?: string,
    tableName?: string,
  ): Promise<IVectorSearchResult[]> {
    const table: Table = await this.ensureTableAsync(tableName);

    const rowCount: number = await table.countRows();

    if (rowCount === 0) {
      return [];
    }

    let query = table.search(queryVector).limit(limit);

    if (collectionFilter) {
      query = query.where(`collection = '${collectionFilter}'`);
    }

    const rawResults = await query.toArray();

    const results: IVectorSearchResult[] = rawResults.map(
      (raw: Record<string, unknown>) => {
        const row = raw as Record<string, unknown>;
        const distance: number = typeof row._distance === "number" ? row._distance : 0;

        return {
          id: _readRequiredString(row, "id"),
          content: _readRequiredString(row, "content"),
          collection: _readRequiredString(row, "collection"),
          metadata: _readRequiredString(row, "metadata"),
          score: 1 - distance,
        };
      },
    );

    return results;
  }

  public async deleteAsync(
    predicate: string,
    tableName?: string,
  ): Promise<void> {
    const table: Table = await this.ensureTableAsync(tableName);

    await table.delete(predicate);
  }

  public async updateAsync(
    id: string,
    updates: Partial<Omit<IVectorRecord, "id">>,
    tableName?: string,
  ): Promise<void> {
    const table: Table = await this.ensureTableAsync(tableName);

    const existingRows = await table
      .query()
      .where(`id = '${id}'`)
      .limit(1)
      .toArray();

    if (existingRows.length === 0) {
      throw new Error(`Record not found: ${id}`);
    }

    const existingRow = existingRows[0] as Record<string, unknown>;

    const mergedRecord: IVectorRecord = {
      id: _readRequiredString(existingRow, "id"),
      content: updates.content ?? _readRequiredString(existingRow, "content"),
      collection: updates.collection ?? _readRequiredString(existingRow, "collection"),
      vector: updates.vector ?? _readRequiredNumberArray(existingRow, "vector"),
      metadata: updates.metadata ?? _readRequiredString(existingRow, "metadata"),
      createdAt: _readRequiredString(existingRow, "createdAt"),
      updatedAt: updates.updatedAt ?? new Date().toISOString(),
    };

    await table.delete(`id = '${id}'`);
    await table.add([{ ...mergedRecord }]);
  }

  public async countAsync(
    collectionFilter?: string,
    tableName?: string,
  ): Promise<number> {
    const table: Table = await this.ensureTableAsync(tableName);

    if (collectionFilter) {
      return await table.countRows(`collection = '${collectionFilter}'`);
    }

    return await table.countRows();
  }

  public async closeAsync(): Promise<void> {
    this._tables.clear();
    this._connection = null;
    this._initialized = false;
  }

  //#endregion Public methods

  //#region Private methods

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error(
        "VectorStoreService not initialized. Call initializeAsync() first.",
      );
    }
  }

  //#endregion Private methods
}

function _readRequiredString(row: Record<string, unknown>, key: string): string {
  const value: unknown = row[key];
  if (typeof value !== "string") {
    throw new Error(`Malformed vector row: expected string field "${key}"`);
  }
  return value;
}

function _readRequiredNumberArray(row: Record<string, unknown>, key: string): number[] {
  const value: unknown = row[key];
  if (!Array.isArray(value) || !value.every((item: unknown): boolean => typeof item === "number")) {
    throw new Error(`Malformed vector row: expected number[] field "${key}"`);
  }
  return value;
}
