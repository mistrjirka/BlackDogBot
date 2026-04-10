import { beforeEach, describe, expect, it, vi } from "vitest";

import * as litesql from "../../../src/helpers/litesql.js";
import { createTableTool } from "../../../src/tools/create-table.tool.js";
import { resetSingletons } from "../../utils/test-helpers.js";

vi.mock("../../../src/helpers/litesql.js");

describe("create_table tool", () => {
  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("auto-creates the database if it does not exist", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.createDatabaseAsync).mockResolvedValue(undefined);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.createTableAsync).mockResolvedValue(undefined);

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", notNull: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.databaseName).toBe("blackdog");
    expect(result.tableName).toBe("messages");
    expect(litesql.createDatabaseAsync).toHaveBeenCalledWith("blackdog");
    expect(litesql.createTableAsync).toHaveBeenCalledWith("blackdog", "messages", expect.any(Array));
  });

  it("does not include confusing 'Available databases' in error messages", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.listDatabasesAsync).mockResolvedValue([]);

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", notNull: true },
      ],
    });

    if (!result.success && result.error) {
      expect(result.error).not.toContain("Available databases");
    }
  });

  it("succeeds when database already exists", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.createTableAsync).mockResolvedValue(undefined);

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", notNull: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(litesql.createDatabaseAsync).not.toHaveBeenCalled();
  });

  it("rejects defaultValue usage in create_table", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", defaultValue: "anything" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("defaultValue is no longer supported");
  });

  it("ignores unrelated extra properties and still creates table", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.createTableAsync).mockResolvedValue(undefined);

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", randomExtraProperty: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("creates table successfully without defaultValue support", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.createTableAsync).mockResolvedValue(undefined);

    const result = await (createTableTool as any).execute({
      tableName: "events",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
