import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as litesql from "../../../src/helpers/litesql.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { IQueryResult } from "../../../src/helpers/litesql.js";

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-litesql-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}


describe("LiteSqlService", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  describe("listDatabasesAsync", () => {
    it("should return empty array when no databases exist", async () => {
      const databases = await litesql.listDatabasesAsync();

      expect(databases).toEqual([]);
    });
  });

  describe("createDatabaseAsync", () => {
    it("should create a new database", async () => {
      await litesql.createDatabaseAsync("testdb");

      const databases = await litesql.listDatabasesAsync();
      expect(databases).toHaveLength(1);
      expect(databases[0].name).toBe("testdb");
    });

    it("should throw when database already exists", async () => {
      await litesql.createDatabaseAsync("testdb");

      await expect(litesql.createDatabaseAsync("testdb")).rejects.toThrow("already exists");
    });

    it("should throw for invalid database names", async () => {
      await expect(litesql.createDatabaseAsync("test-db")).rejects.toThrow("alphanumeric");
      await expect(litesql.createDatabaseAsync("test db")).rejects.toThrow("alphanumeric");
    });
  });

  describe("listTablesAsync", () => {
    it("should return empty array for new database", async () => {
      await litesql.createDatabaseAsync("testdb");
      const tables = await litesql.listTablesAsync("testdb");

      expect(tables).toEqual([]);
    });

    it("should throw for non-existent database", async () => {
      await expect(litesql.listTablesAsync("nonexistent")).rejects.toThrow("does not exist");
    });
  });

  describe("createTableAsync", () => {
    it("should create a table with columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "email", type: "TEXT" },
      ]);

      const tables = await litesql.listTablesAsync("testdb");
      expect(tables).toContain("users");
    });

    it("should throw for non-existent database", async () => {
      await expect(
        litesql.createTableAsync("nonexistent", "users", [{ name: "id", type: "INTEGER" }]),
      ).rejects.toThrow("does not exist");
    });
  });

  describe("getTableSchemaAsync", () => {
    it("should return table schema", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "email", type: "TEXT" },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "users");

      expect(schema.name).toBe("users");
      expect(schema.columns).toHaveLength(3);

      const idCol = schema.columns.find((c) => c.name === "id");
      expect(idCol?.type).toBe("INTEGER");
      expect(idCol?.primaryKey).toBe(true);

      const nameCol = schema.columns.find((c) => c.name === "name");
      expect(nameCol?.type).toBe("TEXT");
      expect(nameCol?.notNull).toBe(true);
    });

    it("should throw for non-existent table", async () => {
      await litesql.createDatabaseAsync("testdb");

      await expect(litesql.getTableSchemaAsync("testdb", "nonexistent")).rejects.toThrow(
        "does not exist",
      );
    });
  });

  describe("insertIntoTableAsync", () => {
    it("should insert a single row", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      const result = await litesql.insertIntoTableAsync("testdb", "users", {
        id: 1,
        name: "John",
      });

      expect(result.insertedCount).toBe(1);
      expect(result.lastRowId).toBe(1);
    });

    it("should insert multiple rows", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      const result = await litesql.insertIntoTableAsync("testdb", "users", [
        { id: 1, name: "John" },
        { id: 2, name: "Jane" },
      ]);

      expect(result.insertedCount).toBe(2);
    });

    it("should throw on duplicate key", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      await litesql.insertIntoTableAsync("testdb", "users", { id: 1, name: "John" });

      await expect(litesql.insertIntoTableAsync("testdb", "users", { id: 1, name: "Jane" })).rejects
        .toThrow("UNIQUE constraint failed");
    });
  });

  describe("dropTableAsync", () => {
    it("should drop a table", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER" },
      ]);

      await litesql.dropTableAsync("testdb", "users");

      const tables = await litesql.listTablesAsync("testdb");
      expect(tables).toEqual([]);
    });
  });

  describe("databaseExistsAsync", () => {
    it("should return true for existing database", async () => {
      await litesql.createDatabaseAsync("testdb");

      const exists = await litesql.databaseExistsAsync("testdb");
      expect(exists).toBe(true);
    });

    it("should return false for non-existent database", async () => {
      const exists = await litesql.databaseExistsAsync("nonexistent");
      expect(exists).toBe(false);
    });
  });

  describe("tableExistsAsync", () => {
    it("should return true for existing table", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [{ name: "id", type: "INTEGER" }]);

      const exists = await litesql.tableExistsAsync("testdb", "users");
      expect(exists).toBe(true);
    });

    it("should return false for non-existent table", async () => {
      await litesql.createDatabaseAsync("testdb");

      const exists = await litesql.tableExistsAsync("testdb", "nonexistent");
      expect(exists).toBe(false);
    });
  });

  describe("queryTableAsync", () => {
    it("returns all rows when no options are given", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "TEXT" },
      ]);
      await litesql.insertIntoTableAsync("testdb", "users", [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ]);

      const result: IQueryResult = await litesql.queryTableAsync("testdb", "users");

      expect(result.rows).toHaveLength(3);
      expect(result.totalCount).toBe(3);
    });

    it("filters rows with a WHERE clause", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "TEXT" },
      ]);
      await litesql.insertIntoTableAsync("testdb", "users", [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]);

      const result: IQueryResult = await litesql.queryTableAsync("testdb", "users", {
        where: "name = 'Alice'",
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]["name"]).toBe("Alice");
      expect(result.totalCount).toBe(1);
    });

    it("limits the number of returned rows", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "items", [
        { name: "id", type: "INTEGER" },
        { name: "value", type: "TEXT" },
      ]);
      await litesql.insertIntoTableAsync("testdb", "items", [
        { id: 1, value: "a" },
        { id: 2, value: "b" },
        { id: 3, value: "c" },
        { id: 4, value: "d" },
      ]);

      const result: IQueryResult = await litesql.queryTableAsync("testdb", "items", {
        limit: 2,
      });

      expect(result.rows).toHaveLength(2);
    });

    it("orders rows by the specified column", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "scores", [
        { name: "id", type: "INTEGER" },
        { name: "score", type: "INTEGER" },
      ]);
      await litesql.insertIntoTableAsync("testdb", "scores", [
        { id: 1, score: 30 },
        { id: 2, score: 10 },
        { id: 3, score: 20 },
      ]);

      const result: IQueryResult = await litesql.queryTableAsync("testdb", "scores", {
        orderBy: "score ASC",
      });

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]["score"]).toBe(10);
      expect(result.rows[1]["score"]).toBe(20);
      expect(result.rows[2]["score"]).toBe(30);
    });

    it("selects only specified columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "people", [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "TEXT" },
        { name: "age", type: "INTEGER" },
      ]);
      await litesql.insertIntoTableAsync("testdb", "people", [
        { id: 1, name: "Alice", age: 30 },
      ]);

      const result: IQueryResult = await litesql.queryTableAsync("testdb", "people", {
        columns: ["name"],
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty("name");
      expect(result.rows[0]).not.toHaveProperty("id");
      expect(result.rows[0]).not.toHaveProperty("age");
    });

    it("returns correct totalCount even when limit is applied", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "items", [
        { name: "id", type: "INTEGER" },
        { name: "value", type: "TEXT" },
      ]);
      await litesql.insertIntoTableAsync("testdb", "items", [
        { id: 1, value: "a" },
        { id: 2, value: "b" },
        { id: 3, value: "c" },
        { id: 4, value: "d" },
        { id: 5, value: "e" },
      ]);

      const result: IQueryResult = await litesql.queryTableAsync("testdb", "items", {
        limit: 2,
      });

      expect(result.rows).toHaveLength(2);
      expect(result.totalCount).toBe(5);
    });

    it("returns empty rows and zero totalCount for an empty table", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "empty_table", [
        { name: "id", type: "INTEGER" },
      ]);

      const result: IQueryResult = await litesql.queryTableAsync("testdb", "empty_table");

      expect(result.rows).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });
  });
});
