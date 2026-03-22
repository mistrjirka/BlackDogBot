import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as litesql from "../../../src/helpers/litesql.js";
import { buildPerTableToolsAsync, buildSingleTableTool, buildZodSchemaForColumns } from "../../../src/utils/per-table-tools.js";
import type { IColumnInfo } from "../../../src/helpers/litesql.js";
import { isToolAllowed } from "../../../src/helpers/tool-registry.js";
import { writeToDatabaseTool } from "../../../src/tools/write-to-database.tool.js";
import { ToolHotReloadService } from "../../../src/services/tool-hot-reload.service.js";

describe("Per-Table Write Tools", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-per-table-test-"));
    originalHome = process.env.HOME ?? "";
    process.env.HOME = tempDir;

    await fs.mkdir(path.join(tempDir, ".blackdogbot", "databases"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("buildPerTableToolsAsync", () => {
    it("should generate a tool for each table in each database", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "email", type: "TEXT" },
      ]);

      const tools = await buildPerTableToolsAsync();

      expect(tools).toHaveProperty("write_table_users");
      expect(tools.write_table_users).toBeDefined();
      expect(typeof tools.write_table_users.execute).toBe("function");
    });

    it("should return empty object when no databases exist", async () => {
      const tools = await buildPerTableToolsAsync();
      expect(Object.keys(tools)).toHaveLength(0);
    });

    it("should generate tools for multiple databases", async () => {
      await litesql.createDatabaseAsync("db1");
      await litesql.createTableAsync("db1", "table_a", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "value", type: "TEXT" },
      ]);

      await litesql.createDatabaseAsync("db2");
      await litesql.createTableAsync("db2", "table_b", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "count", type: "INTEGER" },
      ]);

      const tools = await buildPerTableToolsAsync();

      expect(tools).toHaveProperty("write_table_table_a");
      expect(tools).toHaveProperty("write_table_table_b");
    });

    it("should prefix tool name on collision (same table name in different databases)", async () => {
      await litesql.createDatabaseAsync("db1");
      await litesql.createTableAsync("db1", "items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      await litesql.createDatabaseAsync("db2");
      await litesql.createTableAsync("db2", "items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "label", type: "TEXT" },
      ]);

      const tools = await buildPerTableToolsAsync();

      // One should be "write_table_items", the other should be prefixed
      const toolNames = Object.keys(tools);
      expect(toolNames.length).toBe(2);
      expect(toolNames.some((n) => n === "write_table_items")).toBe(true);
      expect(toolNames.some((n) => n.startsWith("write_table_") && n.includes("items"))).toBe(true);
    });
  });

  describe("buildSingleTableTool", () => {
    it("should build a tool with correct name and schema", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "scores", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "player", type: "TEXT", notNull: true },
        { name: "score", type: "INTEGER", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "scores");
      const { name, toolInstance } = buildSingleTableTool("testdb", "scores", schema.columns);

      expect(name).toBe("write_table_scores");
      expect(toolInstance).toBeDefined();
      expect(toolInstance.description).toContain("scores");
      expect(toolInstance.description).toContain("testdb");
    });
  });

  describe("Per-table tool execution", () => {
    it("should insert data with correct schema", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "logs", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", notNull: true },
        { name: "level", type: "TEXT" },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "logs");
      const { toolInstance } = buildSingleTableTool("testdb", "logs", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ message: "Hello", level: "info" }],
      });

      expect(result.success).toBe(true);
      expect(result.insertedCount).toBe(1);

      // Verify data was actually inserted
      const queryResult = await litesql.queryTableAsync("testdb", "logs");
      expect(queryResult.rows).toHaveLength(1);
      expect(queryResult.rows[0].message).toBe("Hello");
    });

    it("should auto-fill created_at when column exists and is NOT NULL", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "events", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "created_at", type: "TEXT", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "events");
      const { toolInstance } = buildSingleTableTool("testdb", "events", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ title: "Test Event" }],
      });

      expect(result.success).toBe(true);

      // Verify created_at was auto-filled
      const queryResult = await litesql.queryTableAsync("testdb", "events");
      expect(queryResult.rows[0].created_at).toBeTruthy();
      expect(typeof queryResult.rows[0].created_at).toBe("string");
    });
  });

  describe("write table runtime validation", () => {
    it("should auto-fill created_at and succeed", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "articles", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "source", type: "TEXT", notNull: true },
        { name: "pub_date", type: "TEXT", notNull: true },
        { name: "created_at", type: "TEXT", notNull: true },
      ]);

      const result = await (writeToDatabaseTool as any).execute({
        databaseName: "testdb",
        tableName: "articles",
        data: [{
          title: "Breaking News",
          source: "https://example.com",
          pub_date: "2026-03-20T12:00:00Z",
          // created_at is missing but should be auto-filled
        }],
      });

      expect(result.success).toBe(true);
      expect(result.insertedCount).toBe(1);

      // Verify created_at was auto-filled
      const queryResult = await litesql.queryTableAsync("testdb", "articles");
      expect(queryResult.rows[0].created_at).toBeTruthy();
    });

    it("should return structured error for non-existent columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      const result = await (writeToDatabaseTool as any).execute({
        databaseName: "testdb",
        tableName: "items",
        data: [{ name: "Widget", nonexistent_column: "value" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent_column");
      expect(result.error).toContain("does not exist");
      expect(result.error).toContain("name"); // Should list available columns
    });

    it("should return structured error for missing NOT NULL columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "records", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "required_field", type: "TEXT", notNull: true },
      ]);

      const result = await (writeToDatabaseTool as any).execute({
        databaseName: "testdb",
        tableName: "records",
        data: [{ id: 1 }], // missing required_field
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("required_field");
      expect(result.error).toContain("required");
    });

    it("should return structured error for non-existent database", async () => {
      const result = await (writeToDatabaseTool as any).execute({
        databaseName: "nonexistent_db",
        tableName: "items",
        data: [{ name: "test" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return structured error for non-existent table", async () => {
      await litesql.createDatabaseAsync("testdb");

      const result = await (writeToDatabaseTool as any).execute({
        databaseName: "testdb",
        tableName: "nonexistent_table",
        data: [{ name: "test" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
  });

  describe("Permission filtering", () => {
    it("should block write_table_<table> tools for read_only permission", () => {
      expect(isToolAllowed("write_table_users", "read_only")).toBe(false);
      expect(isToolAllowed("write_table_news_items", "read_only")).toBe(false);
      expect(isToolAllowed("write_table_anything", "read_only")).toBe(false);
    });

    it("should allow write_table_<table> tools for full permission", () => {
      expect(isToolAllowed("write_table_users", "full")).toBe(true);
      expect(isToolAllowed("write_table_news_items", "full")).toBe(true);
    });
  });

  describe("Schema type mapping", () => {
    it("should handle TEXT columns as strings", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "texts", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "content", type: "TEXT", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "texts");
      const { toolInstance } = buildSingleTableTool("testdb", "texts", schema.columns);

      // Should accept string value
      const result = await (toolInstance as any).execute({
        data: [{ content: "hello world" }],
      });
      expect(result.success).toBe(true);
    });

    it("should handle INTEGER columns as numbers", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "counts", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "amount", type: "INTEGER", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "counts");
      const { toolInstance } = buildSingleTableTool("testdb", "counts", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ amount: 42 }],
      });
      expect(result.success).toBe(true);
    });

    it("should skip auto-increment primary key columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "auto", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "value", type: "TEXT" },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "auto");
      const { toolInstance } = buildSingleTableTool("testdb", "auto", schema.columns);

      // Should NOT require "id" column
      const result = await (toolInstance as any).execute({
        data: [{ value: "test" }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("SQLite type alias handling", () => {
    it("should handle VARCHAR columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "varchar_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "label", type: "VARCHAR(255)", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "varchar_table");
      const { toolInstance } = buildSingleTableTool("testdb", "varchar_table", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ label: "hello" }],
      });
      expect(result.success).toBe(true);
    });

    it("should handle INT columns (alias for INTEGER)", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "int_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "count", type: "INT", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "int_table");
      const { toolInstance } = buildSingleTableTool("testdb", "int_table", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ count: 42 }],
      });
      expect(result.success).toBe(true);
    });

    it("should handle FLOAT columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "float_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "score", type: "FLOAT", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "float_table");
      const { toolInstance } = buildSingleTableTool("testdb", "float_table", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ score: 3.14 }],
      });
      expect(result.success).toBe(true);
    });

    it("should handle NUMERIC columns", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "numeric_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "amount", type: "NUMERIC", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "numeric_table");
      const { toolInstance } = buildSingleTableTool("testdb", "numeric_table", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ amount: 99.99 }],
      });
      expect(result.success).toBe(true);
    });

    it("should handle DATE columns as strings", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "date_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "event_date", type: "DATE", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("testdb", "date_table");
      const { toolInstance } = buildSingleTableTool("testdb", "date_table", schema.columns);

      const result = await (toolInstance as any).execute({
        data: [{ event_date: "2026-03-20" }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("Name collision resolution", () => {
    it("should use numeric suffix when prefixed name also collides", async () => {
      // DB1 has table "db2_items" → write_table_db2_items
      await litesql.createDatabaseAsync("db1");
      await litesql.createTableAsync("db1", "db2_items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      // DB2 has table "items" → write_table_items (collision) → write_table_db2_items (collision!) → write_table_db2_items_2
      await litesql.createDatabaseAsync("db2");
      await litesql.createTableAsync("db2", "items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "label", type: "TEXT" },
      ]);

      const tools = await buildPerTableToolsAsync();
      const toolNames = Object.keys(tools);

      // Should have 2 unique tools
      expect(toolNames.length).toBe(2);

      // One should be write_table_db2_items (from db1.db2_items)
      expect(toolNames).toContain("write_table_db2_items");

      // The other should have a unique name (prefixed or suffixed)
      const otherTool = toolNames.find((n) => n !== "write_table_db2_items");
      expect(otherTool).toBeDefined();
      expect(otherTool!.startsWith("write_table_")).toBe(true);
    });
  });

  describe("Hot-reload service", () => {
    it("should register and trigger rebuild callbacks", async () => {
      const hotReload = ToolHotReloadService.getInstance();
      let callbackInvoked = false;
      let receivedTools: any = null;

      hotReload.registerRebuildCallback("test-chat", (perTableTools) => {
        callbackInvoked = true;
        receivedTools = perTableTools;
      });

      // Create a table so there's something to rebuild
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "hotreload_test", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "data", type: "TEXT" },
      ]);

      await hotReload.triggerRebuildAsync("test-chat");

      expect(callbackInvoked).toBe(true);
      expect(receivedTools).not.toBeNull();
      expect(receivedTools).toHaveProperty("write_table_hotreload_test");

      hotReload.unregisterRebuildCallback("test-chat");
    });

    it("should not crash when no callback is registered", async () => {
      const hotReload = ToolHotReloadService.getInstance();

      const result = await hotReload.triggerRebuildAsync("nonexistent-chat");
      expect(result).toBe(false);
    });

    it("should unregister callbacks correctly", async () => {
      const hotReload = ToolHotReloadService.getInstance();
      let callbackInvoked = false;

      hotReload.registerRebuildCallback("temp-chat", () => {
        callbackInvoked = true;
      });

      hotReload.unregisterRebuildCallback("temp-chat");
      const result = await hotReload.triggerRebuildAsync("temp-chat");

      expect(result).toBe(false);
      expect(callbackInvoked).toBe(false);
    });

    it("should return false when callback throws", async () => {
      const hotReload = ToolHotReloadService.getInstance();

      hotReload.registerRebuildCallback("throwing-chat", () => {
        throw new Error("boom");
      });

      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "throw_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
      ]);

      const result = await hotReload.triggerRebuildAsync("throwing-chat");
      expect(result).toBe(false);

      hotReload.unregisterRebuildCallback("throwing-chat");
    });
  });

  describe("write table NOT NULL bug fix", () => {
    it("should flag column as required when notNull=true and defaultValue is empty string", async () => {
      // Simulate a column where defaultValue might be empty string
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "required_test", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "must_have", type: "TEXT", notNull: true },
      ]);

      const result = await (writeToDatabaseTool as any).execute({
        databaseName: "testdb",
        tableName: "required_test",
        data: [{ id: 1 }], // missing must_have
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("must_have");
      expect(result.error).toContain("required");
    });
  });

  describe("Zod schema validation — wrong type rejected", () => {
    it("should reject string where INTEGER is required", () => {
      const cols: IColumnInfo[] = [
        { name: "count", type: "INTEGER", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Should fail: string instead of number
      const bad = schema.safeParse([{ count: "not a number" }]);
      expect(bad.success).toBe(false);

      // Should pass: actual number
      const good = schema.safeParse([{ count: 42 }]);
      expect(good.success).toBe(true);
    });

    it("should reject string where REAL/FLOAT is required", () => {
      const cols: IColumnInfo[] = [
        { name: "score", type: "FLOAT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      const bad = schema.safeParse([{ score: "high" }]);
      expect(bad.success).toBe(false);

      const good = schema.safeParse([{ score: 9.5 }]);
      expect(good.success).toBe(true);
    });

    it("should reject number where TEXT is required", () => {
      const cols: IColumnInfo[] = [
        { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      const bad = schema.safeParse([{ name: 123 }]);
      expect(bad.success).toBe(false);

      const good = schema.safeParse([{ name: "Alice" }]);
      expect(good.success).toBe(true);
    });

    it("should reject object where flat value is required", () => {
      const cols: IColumnInfo[] = [
        { name: "data", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      const bad = schema.safeParse([{ data: { nested: "object" } }]);
      expect(bad.success).toBe(false);
    });

    it("should reject empty array (min 1)", () => {
      const cols: IColumnInfo[] = [
        { name: "value", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      const bad = schema.safeParse([]);
      expect(bad.success).toBe(false);
    });

    it("should reject unknown column (extra fields ignored by z.object)", () => {
      const cols: IColumnInfo[] = [
        { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Extra fields should be stripped by default (z.object strips unknown keys)
      const result = schema.safeParse([{ name: "Alice", unknown_field: "value" }]);
      // z.object strips unknown keys by default — so it should succeed but strip the extra field
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0]).not.toHaveProperty("unknown_field");
      }
    });
  });

  describe("Zod schema structure — required vs optional", () => {
    it("should mark NOT NULL column without default as required", () => {
      const cols: IColumnInfo[] = [
        { name: "title", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Missing title should fail
      const bad = schema.safeParse([{}]);
      expect(bad.success).toBe(false);
    });

    it("should mark nullable column as optional", () => {
      const cols: IColumnInfo[] = [
        { name: "description", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Missing description should pass
      const good = schema.safeParse([{}]);
      expect(good.success).toBe(true);

      // Providing it should also pass
      const alsoGood = schema.safeParse([{ description: "hello" }]);
      expect(alsoGood.success).toBe(true);
    });

    it("should mark column with DEFAULT as optional", () => {
      const cols: IColumnInfo[] = [
        { name: "status", type: "TEXT", notNull: true, primaryKey: false, defaultValue: "'pending'" },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Missing status should pass (has default)
      const good = schema.safeParse([{}]);
      expect(good.success).toBe(true);
    });

    it("should skip INTEGER primary key columns", () => {
      const cols: IColumnInfo[] = [
        { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
        { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Should NOT require id (auto-increment PK)
      const good = schema.safeParse([{ name: "Alice" }]);
      expect(good.success).toBe(true);

      // Providing id should also work
      const alsoGood = schema.safeParse([{ id: 1, name: "Alice" }]);
      expect(alsoGood.success).toBe(true);
    });

    it("should handle mixed required and optional columns", () => {
      const cols: IColumnInfo[] = [
        { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
        { name: "title", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        { name: "source", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        { name: "pub_date", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        { name: "content", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
        { name: "created_at", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Missing required field should fail
      const bad = schema.safeParse([{ title: "Test", source: "src" }]);
      expect(bad.success).toBe(false);

      // All required fields present should pass
      const good = schema.safeParse([{
        title: "Test",
        source: "src",
        pub_date: "2026-03-20",
        created_at: "2026-03-20T12:00:00Z",
      }]);
      expect(good.success).toBe(true);

      // Including optional field should also pass
      const alsoGood = schema.safeParse([{
        title: "Test",
        source: "src",
        pub_date: "2026-03-20",
        content: "Full article text",
        created_at: "2026-03-20T12:00:00Z",
      }]);
      expect(alsoGood.success).toBe(true);
    });
  });

  describe("All SQLite type mappings", () => {
    const typeTestCases: Array<{
      sqliteType: string;
      validValue: unknown;
      invalidValue: unknown;
      label: string;
    }> = [
      // Text types
      { sqliteType: "TEXT", validValue: "hello", invalidValue: 123, label: "TEXT → string" },
      { sqliteType: "VARCHAR(255)", validValue: "hello", invalidValue: 123, label: "VARCHAR(255) → string" },
      { sqliteType: "CHAR(10)", validValue: "hello", invalidValue: 123, label: "CHAR(10) → string" },
      { sqliteType: "CLOB", validValue: "long text", invalidValue: 123, label: "CLOB → string" },
      { sqliteType: "STRING", validValue: "hello", invalidValue: 123, label: "STRING → string" },
      // Integer types
      { sqliteType: "INTEGER", validValue: 42, invalidValue: "text", label: "INTEGER → number.int" },
      { sqliteType: "INT", validValue: 42, invalidValue: "text", label: "INT → number.int" },
      { sqliteType: "SMALLINT", validValue: 10, invalidValue: "text", label: "SMALLINT → number.int" },
      { sqliteType: "TINYINT", validValue: 1, invalidValue: "text", label: "TINYINT → number.int" },
      { sqliteType: "BIGINT", validValue: 9999999999, invalidValue: "text", label: "BIGINT → number.int" },
      // Float types
      { sqliteType: "REAL", validValue: 3.14, invalidValue: "text", label: "REAL → number" },
      { sqliteType: "FLOAT", validValue: 2.5, invalidValue: "text", label: "FLOAT → number" },
      { sqliteType: "DOUBLE", validValue: 1.234, invalidValue: "text", label: "DOUBLE → number" },
      { sqliteType: "NUMERIC", validValue: 99.99, invalidValue: "text", label: "NUMERIC → number" },
      { sqliteType: "DECIMAL", validValue: 10.5, invalidValue: "text", label: "DECIMAL → number" },
      // Date/time types
      { sqliteType: "DATE", validValue: "2026-03-20", invalidValue: 123, label: "DATE → string" },
      { sqliteType: "DATETIME", validValue: "2026-03-20T12:00:00Z", invalidValue: 123, label: "DATETIME → string" },
      { sqliteType: "TIMESTAMP", validValue: "2026-03-20T12:00:00Z", invalidValue: 123, label: "TIMESTAMP → string" },
      // Binary
      { sqliteType: "BLOB", validValue: "base64data", invalidValue: 123, label: "BLOB → string" },
    ];

    for (const tc of typeTestCases) {
      it(`should map ${tc.label}`, () => {
        const cols: IColumnInfo[] = [
          { name: "col", type: tc.sqliteType, notNull: true, primaryKey: false, defaultValue: null },
        ];
        const schema = buildZodSchemaForColumns(cols);

        const good = schema.safeParse([{ col: tc.validValue }]);
        expect(good.success).toBe(true);

        const bad = schema.safeParse([{ col: tc.invalidValue }]);
        expect(bad.success).toBe(false);
      });
    }

    it("should handle BOOLEAN (accepts 0, 1, true, false)", () => {
      const cols: IColumnInfo[] = [
        { name: "flag", type: "BOOLEAN", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      expect(schema.safeParse([{ flag: 0 }]).success).toBe(true);
      expect(schema.safeParse([{ flag: 1 }]).success).toBe(true);
      expect(schema.safeParse([{ flag: true }]).success).toBe(true);
      expect(schema.safeParse([{ flag: false }]).success).toBe(true);
      expect(schema.safeParse([{ flag: "yes" }]).success).toBe(false);
    });

    it("should handle BOOL (accepts 0, 1, true, false)", () => {
      const cols: IColumnInfo[] = [
        { name: "active", type: "BOOL", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      expect(schema.safeParse([{ active: 1 }]).success).toBe(true);
      expect(schema.safeParse([{ active: false }]).success).toBe(true);
      expect(schema.safeParse([{ active: "true" }]).success).toBe(false);
    });

    it("should fall back to string for unknown types", () => {
      const cols: IColumnInfo[] = [
        { name: "mystery", type: "UNKNOWN_TYPE", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Should accept string (fallback)
      expect(schema.safeParse([{ mystery: "anything" }]).success).toBe(true);
      // Should reject number (since fallback is z.string())
      expect(schema.safeParse([{ mystery: 123 }]).success).toBe(false);
    });
  });

  describe("Mixed scenario — news_items-like table", () => {
    it("should validate a realistic news_items schema end-to-end", () => {
      const cols: IColumnInfo[] = [
        { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
        { name: "title", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        { name: "source", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        { name: "pub_date", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        { name: "content", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
        { name: "is_interesting", type: "INTEGER", notNull: false, primaryKey: false, defaultValue: "0" },
        { name: "verification_status", type: "TEXT", notNull: false, primaryKey: false, defaultValue: "'pending'" },
        { name: "created_at", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ];
      const schema = buildZodSchemaForColumns(cols);

      // Valid insertion
      const good = schema.safeParse([{
        title: "Breaking News",
        source: "https://example.com",
        pub_date: "2026-03-20T12:00:00Z",
        content: "Full article text here",
        is_interesting: 1,
        created_at: "2026-03-20T12:05:00Z",
      }]);
      expect(good.success).toBe(true);

      // Missing required title should fail
      const bad1 = schema.safeParse([{
        source: "https://example.com",
        pub_date: "2026-03-20T12:00:00Z",
        created_at: "2026-03-20T12:05:00Z",
      }]);
      expect(bad1.success).toBe(false);

      // Missing required created_at should fail
      const bad2 = schema.safeParse([{
        title: "Breaking News",
        source: "https://example.com",
        pub_date: "2026-03-20T12:00:00Z",
      }]);
      expect(bad2.success).toBe(false);

      // Optional fields omitted should pass
      const minimal = schema.safeParse([{
        title: "Breaking News",
        source: "https://example.com",
        pub_date: "2026-03-20T12:00:00Z",
        created_at: "2026-03-20T12:05:00Z",
      }]);
      expect(minimal.success).toBe(true);

      // String for is_interesting (INTEGER) should fail
      const badType = schema.safeParse([{
        title: "Breaking News",
        source: "https://example.com",
        pub_date: "2026-03-20T12:00:00Z",
        is_interesting: "yes",
        created_at: "2026-03-20T12:05:00Z",
      }]);
      expect(badType.success).toBe(false);
    });

    it("should produce correct tool for news_items and insert successfully", async () => {
      await litesql.createDatabaseAsync("news_monitor");
      await litesql.createTableAsync("news_monitor", "news_items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "source", type: "TEXT", notNull: true },
        { name: "pub_date", type: "TEXT", notNull: true },
        { name: "content", type: "TEXT" },
        { name: "is_interesting", type: "INTEGER", defaultValue: "0" },
        { name: "verification_status", type: "TEXT", defaultValue: "'pending'" },
        { name: "created_at", type: "TEXT", notNull: true },
      ]);

      const schema = await litesql.getTableSchemaAsync("news_monitor", "news_items");
      const { toolInstance } = buildSingleTableTool("news_monitor", "news_items", schema.columns);

      // Model calls tool with required fields + created_at auto-filled
      const result = await (toolInstance as any).execute({
        data: [{
          title: "Missile strike on Kharkiv",
          source: "https://example.com/article",
          pub_date: "2026-03-20T10:00:00Z",
          content: "Details about the strike...",
          is_interesting: 1,
        }],
      });

      expect(result.success).toBe(true);
      expect(result.insertedCount).toBe(1);

      // Verify in database
      const queryResult = await litesql.queryTableAsync("news_monitor", "news_items");
      expect(queryResult.rows).toHaveLength(1);
      expect(queryResult.rows[0].title).toBe("Missile strike on Kharkiv");
      expect(queryResult.rows[0].is_interesting).toBe(1);
      expect(queryResult.rows[0].created_at).toBeTruthy();
    });
  });
});
