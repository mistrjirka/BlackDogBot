import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as litesql from "../../../src/helpers/litesql.js";
import { writeToDatabaseTool } from "../../../src/tools/write-to-database.tool.js";
import { readFromDatabaseTool } from "../../../src/tools/read-from-database.tool.js";
import { updateDatabaseTool } from "../../../src/tools/update-database.tool.js";
import { deleteFromDatabaseTool } from "../../../src/tools/delete-from-database.tool.js";
import { buildPerTableToolsAsync, buildSingleTableTool } from "../../../src/utils/per-table-tools.js";

describe("Database CRUD E2E", () => {
  let tempDir: string;
  let originalHome: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-db-e2e-"));
    originalHome = process.env.HOME ?? "";
    process.env.HOME = tempDir;

    await fs.mkdir(path.join(tempDir, ".blackdogbot", "databases"), {
      recursive: true,
    });
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("full CRUD workflow", () => {
    const dbName = "e2e_test_db";
    const tableName = "items";

    it("should create database", async () => {
      await litesql.createDatabaseAsync(dbName);

      const exists = await litesql.databaseExistsAsync(dbName);
      expect(exists).toBe(true);
    });

    it("should create table with columns", async () => {
      await litesql.createTableAsync(dbName, tableName, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "quantity", type: "INTEGER", notNull: false },
        { name: "created_at", type: "TEXT", notNull: true },
      ]);

      const tableExists = await litesql.tableExistsAsync(dbName, tableName);
      expect(tableExists).toBe(true);

      const schema = await litesql.getTableSchemaAsync(dbName, tableName);
      expect(schema.columns).toHaveLength(4);
    });

    it("should insert data via write_to_database tool", async () => {
      const result = await writeToDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        data: [
          { name: "Widget A", quantity: 10 },
          { name: "Widget B", quantity: 25 },
          { name: "Widget C", quantity: 5 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.insertedCount).toBe(3);
      // created_at should be auto-filled
    });

    it("should read data via read_from_database tool", async () => {
      const result = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
      });

      expect(result.rows).toHaveLength(3);
      expect(result.totalCount).toBe(3);

      const names = result.rows.map((r: Record<string, unknown>) => r.name);
      expect(names).toContain("Widget A");
      expect(names).toContain("Widget B");
      expect(names).toContain("Widget C");
    });

    it("should filter with WHERE clause", async () => {
      const result = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        where: "quantity > 10",
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe("Widget B");
      expect(result.rows[0].quantity).toBe(25);
    });

    it("should select specific columns", async () => {
      const result = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        columns: ["name", "quantity"],
      });

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]).toHaveProperty("name");
      expect(result.rows[0]).toHaveProperty("quantity");
      expect(result.rows[0]).not.toHaveProperty("created_at");
    });

    it("should order by column", async () => {
      const result = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        orderBy: "quantity DESC",
      });

      expect(result.rows[0].name).toBe("Widget B");
      expect(result.rows[1].name).toBe("Widget A");
      expect(result.rows[2].name).toBe("Widget C");
    });

    it("should limit results", async () => {
      const result = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        limit: 2,
      });

      expect(result.rows).toHaveLength(2);
      expect(result.totalCount).toBe(3);
    });

    it("should update data via update_database tool", async () => {
      const result = await updateDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        set: { quantity: 100 },
        where: "name = 'Widget A'",
      });

      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(1);

      // Verify update
      const readResult = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        where: "name = 'Widget A'",
      });

      expect(readResult.rows[0].quantity).toBe(100);
    });

    it("should delete data via delete_from_database tool", async () => {
      const result = await deleteFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        where: "name = 'Widget C'",
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(1);

      // Verify delete
      const readResult = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
      });

      expect(readResult.rows).toHaveLength(2);
      const names = readResult.rows.map((r: Record<string, unknown>) => r.name);
      expect(names).not.toContain("Widget C");
    });

    it("should delete multiple rows", async () => {
      // Insert more items
      await writeToDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        data: [
          { name: "Item X", quantity: 1 },
          { name: "Item Y", quantity: 2 },
          { name: "Item Z", quantity: 3 },
        ],
      });

      const beforeDelete = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        where: "name LIKE 'Item%'",
      });
      expect(beforeDelete.rows).toHaveLength(3);

      const deleteResult = await deleteFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        where: "name LIKE 'Item%'",
      });

      expect(deleteResult.success).toBe(true);
      expect(deleteResult.deletedCount).toBe(3);

      const afterDelete = await readFromDatabaseTool.invoke({
        databaseName: dbName,
        tableName,
        where: "name LIKE 'Item%'",
      });
      expect(afterDelete.rows).toHaveLength(0);
    });
  });

  describe("per-table tool workflow", () => {
    const dbName = "per_table_test";
    const tableName = "products";

    it("should create database and table", async () => {
      await litesql.createDatabaseAsync(dbName);
      await litesql.createTableAsync(dbName, tableName, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "product_name", type: "TEXT", notNull: true },
        { name: "price", type: "REAL", notNull: true },
        { name: "category", type: "TEXT" },
        { name: "created_at", type: "TEXT", notNull: true },
      ]);
    });

    it("should generate per-table tool", async () => {
      const tools = await buildPerTableToolsAsync();
      expect(tools).toHaveProperty("write_table_products");
    });

    it("should insert data via per-table tool", async () => {
      const schema = await litesql.getTableSchemaAsync(dbName, tableName);
      const { toolInstance } = buildSingleTableTool(
        dbName,
        tableName,
        schema.columns
      );

      const result = await toolInstance.invoke({
        data: [
          { product_name: "Laptop", price: 999.99, category: "Electronics" },
          { product_name: "Book", price: 19.99, category: "Education" },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.insertedCount).toBe(2);

      // Verify in database
      const queryResult = await litesql.queryTableAsync(dbName, tableName);
      expect(queryResult.rows).toHaveLength(2);
      expect(queryResult.rows[0].product_name).toBe("Laptop");
      expect(queryResult.rows[0].price).toBe(999.99);
      expect(queryResult.rows[0].created_at).toBeTruthy();
    });

    it("should reject invalid column names via per-table tool", async () => {
      const schema = await litesql.getTableSchemaAsync(dbName, tableName);
      const { toolInstance } = buildSingleTableTool(
        dbName,
        tableName,
        schema.columns
      );

      // Zod should strip unknown fields
      const result = await toolInstance.invoke({
        data: [
          { product_name: "Tablet", price: 299.99, invalid_column: "bad" },
        ],
      });

      expect(result.success).toBe(true);
      // The unknown field should have been stripped
      const queryResult = await litesql.queryTableAsync(
        dbName,
        tableName,
        { where: "product_name = 'Tablet'" }
      );
      expect(queryResult.rows[0]).not.toHaveProperty("invalid_column");
    });
  });

  describe("error handling", () => {
    it("should return error for non-existent database", async () => {
      const result = await writeToDatabaseTool.invoke({
        databaseName: "nonexistent_db",
        tableName: "items",
        data: [{ name: "test" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return error for non-existent table", async () => {
      await litesql.createDatabaseAsync("error_test_db");

      const result = await writeToDatabaseTool.invoke({
        databaseName: "error_test_db",
        tableName: "nonexistent_table",
        data: [{ name: "test" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return error for invalid columns", async () => {
      await litesql.createDatabaseAsync("col_error_db");
      await litesql.createTableAsync("col_error_db", "valid_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      const result = await writeToDatabaseTool.invoke({
        databaseName: "col_error_db",
        tableName: "valid_table",
        data: [{ name: "test", invalid_col: "bad" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid_col");
      expect(result.error).toContain("does not exist");
    });

    it("should return error for missing NOT NULL columns", async () => {
      await litesql.createDatabaseAsync("notnull_error_db");
      await litesql.createTableAsync("notnull_error_db", "strict_table", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "required_field", type: "TEXT", notNull: true },
      ]);

      const result = await writeToDatabaseTool.invoke({
        databaseName: "notnull_error_db",
        tableName: "strict_table",
        data: [{ id: 1 }], // missing required_field
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("required_field");
      expect(result.error).toContain("required");
    });

    it("should return error for update with empty set", async () => {
      const result = await updateDatabaseTool.invoke({
        databaseName: "col_error_db",
        tableName: "valid_table",
        set: {},
        where: "id = 1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("at least one");
    });

    it("should return 0 deleted for non-matching WHERE", async () => {
      await litesql.createDatabaseAsync("delete_test_db");
      await litesql.createTableAsync("delete_test_db", "items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      await litesql.insertIntoTableAsync("delete_test_db", "items", [
        { name: "Item 1" },
      ]);

      const result = await deleteFromDatabaseTool.invoke({
        databaseName: "delete_test_db",
        tableName: "items",
        where: "name = 'Does Not Exist'",
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(0);
    });
  });
});