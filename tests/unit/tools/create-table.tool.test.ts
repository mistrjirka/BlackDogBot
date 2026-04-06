import { describe, expect, it, beforeEach, vi } from "vitest";
import { createTableTool } from "../../../src/tools/create-table.tool.js";
import * as litesql from "../../../src/helpers/litesql.js";

describe("createTableTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates table and returns update tool in response", async () => {
    vi.spyOn(litesql, "databaseExistsAsync").mockResolvedValue(true);
    vi.spyOn(litesql, "tableExistsAsync").mockResolvedValue(false);
    vi.spyOn(litesql, "createTableAsync").mockResolvedValue();

    const result = await createTableTool.invoke({
      databaseName: "testdb",
      tableName: "users",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
        { name: "email", type: "TEXT" },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.tableName).toBe("users");
    expect(result.columns).toHaveLength(3);
    expect(result.updateTool).toBeDefined();
    expect(result.updateTool.name).toBe("update_table_users");
  });

  it("includes update_table in success message", async () => {
    vi.spyOn(litesql, "databaseExistsAsync").mockResolvedValue(true);
    vi.spyOn(litesql, "tableExistsAsync").mockResolvedValue(false);
    vi.spyOn(litesql, "createTableAsync").mockResolvedValue();

    const result = await createTableTool.invoke({
      databaseName: "testdb",
      tableName: "users",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ],
    });

    expect(result.message).toContain("update_table_users");
  });

  it("returns error when database does not exist", async () => {
    vi.spyOn(litesql, "databaseExistsAsync").mockResolvedValue(false);
    vi.spyOn(litesql, "listDatabasesAsync").mockResolvedValue([{ name: "otherdb" }]);

    const result = await createTableTool.invoke({
      databaseName: "nonexistent",
      tableName: "users",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(result.updateTool).toBeUndefined();
  });

  it("returns error when table already exists", async () => {
    vi.spyOn(litesql, "databaseExistsAsync").mockResolvedValue(true);
    vi.spyOn(litesql, "tableExistsAsync").mockResolvedValue(true);

    const result = await createTableTool.invoke({
      databaseName: "testdb",
      tableName: "users",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
    expect(result.updateTool).toBeUndefined();
  });
});
