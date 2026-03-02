import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryDatabaseTool } from "../../../src/tools/query-database.tool.js";
import * as litesql from "../../../src/helpers/litesql.js";
import { ensureAllDirectoriesAsync } from "../../../src/utils/paths.js";

interface IQueryDatabaseInput {
  action: "list_databases" | "list_tables" | "query_table" | "show_schema";
  databaseName?: string;
  tableName?: string;
  where?: string;
  limit?: number;
  orderBy?: string;
  columns?: string[];
}

async function executeTool(input: IQueryDatabaseInput): Promise<unknown> {
  return queryDatabaseTool.execute(input);
}

describe("query-database tool", () => {
  const testDbName = `test_querydb_${Date.now()}`;
  const testTableName = "test_items";

  beforeAll(async () => {
    await ensureAllDirectoriesAsync();
    
    await litesql.createDatabaseAsync(testDbName);
    
    await litesql.createTableAsync(testDbName, testTableName, [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT", notNull: true },
      { name: "value", type: "INTEGER" },
    ]);
    
    await litesql.insertIntoTableAsync(testDbName, testTableName, [
      { id: 1, name: "item1", value: 100 },
      { id: 2, name: "item2", value: 200 },
      { id: 3, name: "item3", value: 300 },
    ]);
  });

  afterAll(async () => {
    await litesql.dropTableAsync(testDbName, testTableName);
  });

  describe("list_databases action", () => {
    it("should list all databases", async () => {
      const result = await executeTool({ action: "list_databases" }) as { success: boolean; databases: { name: string }[] };
      
      expect(result.success).toBe(true);
      expect(result.databases).toBeDefined();
      expect(Array.isArray(result.databases)).toBe(true);
      
      const dbNames = result.databases.map((d) => d.name);
      expect(dbNames).toContain(testDbName);
    });
  });

  describe("list_tables action", () => {
    it("should list tables in a database", async () => {
      const result = await executeTool({ 
        action: "list_tables", 
        databaseName: testDbName 
      }) as { success: boolean; tables: string[] };
      
      expect(result.success).toBe(true);
      expect(result.tables).toBeDefined();
      expect(result.tables).toContain(testTableName);
    });

    it("should fail for non-existent database", async () => {
      const result = await executeTool({ 
        action: "list_tables", 
        databaseName: "nonexistent_db_xyz" 
      }) as { success: boolean; error: string };
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
  });

  describe("query_table action", () => {
    it("should query all rows from a table", async () => {
      const result = await executeTool({ 
        action: "query_table", 
        databaseName: testDbName, 
        tableName: testTableName 
      }) as { success: boolean; rows: Record<string, unknown>[]; totalCount: number };
      
      expect(result.success).toBe(true);
      expect(result.rows).toBeDefined();
      expect(result.rows.length).toBe(3);
      expect(result.totalCount).toBe(3);
    });

    it("should filter rows with where clause", async () => {
      const result = await executeTool({ 
        action: "query_table", 
        databaseName: testDbName, 
        tableName: testTableName,
        where: "value > 150"
      }) as { success: boolean; rows: Record<string, unknown>[] };
      
      expect(result.success).toBe(true);
      expect(result.rows.length).toBe(2);
    });

    it("should order rows with orderBy clause", async () => {
      const result = await executeTool({ 
        action: "query_table", 
        databaseName: testDbName, 
        tableName: testTableName,
        orderBy: "value DESC"
      }) as { success: boolean; rows: Record<string, unknown>[] };
      
      expect(result.success).toBe(true);
      expect(result.rows[0].value).toBe(300);
      expect(result.rows[2].value).toBe(100);
    });

    it("should limit rows", async () => {
      const result = await executeTool({ 
        action: "query_table", 
        databaseName: testDbName, 
        tableName: testTableName,
        limit: 2
      }) as { success: boolean; rows: Record<string, unknown>[]; totalCount: number };
      
      expect(result.success).toBe(true);
      expect(result.rows.length).toBe(2);
      expect(result.totalCount).toBe(3);
    });

    it("should select specific columns", async () => {
      const result = await executeTool({ 
        action: "query_table", 
        databaseName: testDbName, 
        tableName: testTableName,
        columns: ["name"]
      }) as { success: boolean; rows: Record<string, unknown>[] };
      
      expect(result.success).toBe(true);
      expect(result.rows[0]).toHaveProperty("name");
      expect(result.rows[0]).not.toHaveProperty("value");
    });
  });

  describe("show_schema action", () => {
    it("should return table schema", async () => {
      const result = await executeTool({ 
        action: "show_schema", 
        databaseName: testDbName, 
        tableName: testTableName 
      }) as { success: boolean; schema: { name: string; columns: { name: string; type: string }[] } };
      
      expect(result.success).toBe(true);
      expect(result.schema).toBeDefined();
      expect(result.schema.name).toBe(testTableName);
      expect(result.schema.columns).toHaveLength(3);
      
      const columnNames = result.schema.columns.map((c) => c.name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("name");
      expect(columnNames).toContain("value");
    });
  });
});
