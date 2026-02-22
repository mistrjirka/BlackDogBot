import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryDatabaseTool } from "../../src/tools/query-database.tool.js";
import { LiteSqlService } from "../../src/services/litesql.service.js";
import { ensureAllDirectoriesAsync } from "../../src/utils/paths.js";

// Input type for the query-database tool
interface IQueryDatabaseInput {
  action: "list_databases" | "list_tables" | "query_table" | "show_schema";
  databaseName?: string;
  tableName?: string;
  where?: string;
  limit?: number;
  orderBy?: string;
  columns?: string[];
}

// Helper to call the tool with typed input
async function executeTool(input: IQueryDatabaseInput): Promise<unknown> {
  // @ts-expect-error - tool.execute signature
  return queryDatabaseTool.execute(input);
}

describe("query-database tool", () => {
  const testDbName = `test_querydb_${Date.now()}`;
  const testTableName = "test_items";

  beforeAll(async () => {
    await ensureAllDirectoriesAsync();
    const service = LiteSqlService.getInstance();
    
    // Create test database
    await service.createDatabaseAsync(testDbName);
    
    // Create test table
    await service.createTableAsync(testDbName, testTableName, [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT", notNull: true },
      { name: "value", type: "INTEGER" },
    ]);
    
    // Insert test data
    await service.insertIntoTableAsync(testDbName, testTableName, [
      { id: 1, name: "item1", value: 100 },
      { id: 2, name: "item2", value: 200 },
      { id: 3, name: "item3", value: 300 },
    ]);
  });

  afterAll(async () => {
    // Clean up - drop the test database file
    const service = LiteSqlService.getInstance();
    await service.dropTableAsync(testDbName, testTableName);
    // Note: We don't delete the database file, just clean up tables
  });

  describe("list_databases action", () => {
    it("should list all databases", async () => {
      const result = await executeTool({ action: "list_databases" }) as { success: boolean; databases: { name: string }[] };
      
      expect(result.success).toBe(true);
      expect(result.databases).toBeDefined();
      expect(Array.isArray(result.databases)).toBe(true);
      
      // Our test database should be in the list
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
      expect(result.rows.length).toBe(2); // items with value 200 and 300
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
      expect(result.totalCount).toBe(3); // Total count is still 3
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
