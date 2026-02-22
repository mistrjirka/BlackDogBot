import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiteSqlService, IQueryResult } from "../../src/services/litesql.service.js";
import { LoggerService } from "../../src/services/logger.service.js";

//#region Helpers

let _tempDir: string;
let _originalHome: string | undefined;

async function setupTempHomeAsync(): Promise<void> {
  _tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "litesql-query-test-"));
  _originalHome = process.env.HOME;
  process.env.HOME = _tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  if (_originalHome !== undefined) {
    process.env.HOME = _originalHome;
  }
  await fs.rm(_tempDir, { recursive: true, force: true });
}

function resetSingletons(): void {
  (LiteSqlService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

describe("LiteSqlService.queryTableAsync", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  it("returns all rows when no options are given", async () => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    await service.createDatabaseAsync("testdb");
    await service.createTableAsync("testdb", "users", [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
    ]);
    await service.insertIntoTableAsync("testdb", "users", [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Charlie" },
    ]);

    const result: IQueryResult = await service.queryTableAsync("testdb", "users");

    expect(result.rows).toHaveLength(3);
    expect(result.totalCount).toBe(3);
  });

  it("filters rows with a WHERE clause", async () => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    await service.createDatabaseAsync("testdb");
    await service.createTableAsync("testdb", "users", [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
    ]);
    await service.insertIntoTableAsync("testdb", "users", [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    const result: IQueryResult = await service.queryTableAsync("testdb", "users", {
      where: "name = 'Alice'",
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]["name"]).toBe("Alice");
    expect(result.totalCount).toBe(1);
  });

  it("limits the number of returned rows", async () => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    await service.createDatabaseAsync("testdb");
    await service.createTableAsync("testdb", "items", [
      { name: "id", type: "INTEGER" },
      { name: "value", type: "TEXT" },
    ]);
    await service.insertIntoTableAsync("testdb", "items", [
      { id: 1, value: "a" },
      { id: 2, value: "b" },
      { id: 3, value: "c" },
      { id: 4, value: "d" },
    ]);

    const result: IQueryResult = await service.queryTableAsync("testdb", "items", {
      limit: 2,
    });

    expect(result.rows).toHaveLength(2);
  });

  it("orders rows by the specified column", async () => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    await service.createDatabaseAsync("testdb");
    await service.createTableAsync("testdb", "scores", [
      { name: "id", type: "INTEGER" },
      { name: "score", type: "INTEGER" },
    ]);
    await service.insertIntoTableAsync("testdb", "scores", [
      { id: 1, score: 30 },
      { id: 2, score: 10 },
      { id: 3, score: 20 },
    ]);

    const result: IQueryResult = await service.queryTableAsync("testdb", "scores", {
      orderBy: "score ASC",
    });

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]["score"]).toBe(10);
    expect(result.rows[1]["score"]).toBe(20);
    expect(result.rows[2]["score"]).toBe(30);
  });

  it("selects only specified columns", async () => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    await service.createDatabaseAsync("testdb");
    await service.createTableAsync("testdb", "people", [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
      { name: "age", type: "INTEGER" },
    ]);
    await service.insertIntoTableAsync("testdb", "people", [
      { id: 1, name: "Alice", age: 30 },
    ]);

    const result: IQueryResult = await service.queryTableAsync("testdb", "people", {
      columns: ["name"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toHaveProperty("name");
    expect(result.rows[0]).not.toHaveProperty("id");
    expect(result.rows[0]).not.toHaveProperty("age");
  });

  it("returns correct totalCount even when limit is applied", async () => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    await service.createDatabaseAsync("testdb");
    await service.createTableAsync("testdb", "items", [
      { name: "id", type: "INTEGER" },
      { name: "value", type: "TEXT" },
    ]);
    await service.insertIntoTableAsync("testdb", "items", [
      { id: 1, value: "a" },
      { id: 2, value: "b" },
      { id: 3, value: "c" },
      { id: 4, value: "d" },
      { id: 5, value: "e" },
    ]);

    const result: IQueryResult = await service.queryTableAsync("testdb", "items", {
      limit: 2,
    });

    expect(result.rows).toHaveLength(2);
    expect(result.totalCount).toBe(5);
  });

  it("returns empty rows and zero totalCount for an empty table", async () => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    await service.createDatabaseAsync("testdb");
    await service.createTableAsync("testdb", "empty_table", [
      { name: "id", type: "INTEGER" },
    ]);

    const result: IQueryResult = await service.queryTableAsync("testdb", "empty_table");

    expect(result.rows).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });
});
