import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LiteSqlService } from "../../src/services/litesql.service.js";
import { LoggerService } from "../../src/services/logger.service.js";

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-litesql-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

function resetSingletons(): void {
  (LiteSqlService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

describe("LiteSqlService", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  describe("listDatabasesAsync", () => {
    it("should return empty array when no databases exist", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();
      const databases = await service.listDatabasesAsync();

      expect(databases).toEqual([]);
    });
  });

  describe("createDatabaseAsync", () => {
    it("should create a new database", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");

      const databases = await service.listDatabasesAsync();
      expect(databases).toHaveLength(1);
      expect(databases[0].name).toBe("testdb");
    });

    it("should throw when database already exists", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");

      await expect(service.createDatabaseAsync("testdb")).rejects.toThrow("already exists");
    });

    it("should throw for invalid database names", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await expect(service.createDatabaseAsync("test-db")).rejects.toThrow("alphanumeric");
      await expect(service.createDatabaseAsync("test db")).rejects.toThrow("alphanumeric");
    });
  });

  describe("listTablesAsync", () => {
    it("should return empty array for new database", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      const tables = await service.listTablesAsync("testdb");

      expect(tables).toEqual([]);
    });

    it("should throw for non-existent database", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await expect(service.listTablesAsync("nonexistent")).rejects.toThrow("does not exist");
    });
  });

  describe("createTableAsync", () => {
    it("should create a table with columns", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "email", type: "TEXT" },
      ]);

      const tables = await service.listTablesAsync("testdb");
      expect(tables).toContain("users");
    });

    it("should throw for non-existent database", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await expect(
        service.createTableAsync("nonexistent", "users", [{ name: "id", type: "INTEGER" }]),
      ).rejects.toThrow("does not exist");
    });
  });

  describe("getTableSchemaAsync", () => {
    it("should return table schema", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "email", type: "TEXT" },
      ]);

      const schema = await service.getTableSchemaAsync("testdb", "users");

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
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");

      await expect(service.getTableSchemaAsync("testdb", "nonexistent")).rejects.toThrow(
        "does not exist",
      );
    });
  });

  describe("insertIntoTableAsync", () => {
    it("should insert a single row", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      const result = await service.insertIntoTableAsync("testdb", "users", {
        id: 1,
        name: "John",
      });

      expect(result.insertedCount).toBe(1);
      expect(result.lastRowId).toBe(1);
    });

    it("should insert multiple rows", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      const result = await service.insertIntoTableAsync("testdb", "users", [
        { id: 1, name: "John" },
        { id: 2, name: "Jane" },
      ]);

      expect(result.insertedCount).toBe(2);
    });

    it("should throw on duplicate key", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      await service.insertIntoTableAsync("testdb", "users", { id: 1, name: "John" });

      await expect(service.insertIntoTableAsync("testdb", "users", { id: 1, name: "Jane" })).rejects
        .toThrow("UNIQUE constraint failed");
    });
  });

  describe("dropTableAsync", () => {
    it("should drop a table", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER" },
      ]);

      await service.dropTableAsync("testdb", "users");

      const tables = await service.listTablesAsync("testdb");
      expect(tables).toEqual([]);
    });
  });

  describe("databaseExistsAsync", () => {
    it("should return true for existing database", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");

      const exists = await service.databaseExistsAsync("testdb");
      expect(exists).toBe(true);
    });

    it("should return false for non-existent database", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      const exists = await service.databaseExistsAsync("nonexistent");
      expect(exists).toBe(false);
    });
  });

  describe("tableExistsAsync", () => {
    it("should return true for existing table", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [{ name: "id", type: "INTEGER" }]);

      const exists = await service.tableExistsAsync("testdb", "users");
      expect(exists).toBe(true);
    });

    it("should return false for non-existent table", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");

      const exists = await service.tableExistsAsync("testdb", "nonexistent");
      expect(exists).toBe(false);
    });
  });
});
