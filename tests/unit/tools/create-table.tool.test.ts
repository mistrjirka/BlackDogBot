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

  it("rejects malformed defaultValue with unmatched quote at tool level", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.validateDefaultValue).mockImplementation((type: string, value: string) => {
      if (value.includes("'") && value.split("'").length % 2 === 0) {
        throw new Error("Invalid default value for column: unmatched quote in string literal");
      }
    });

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", defaultValue: "'unclosed" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("unmatched quote");
  });

  it("rejects malformed defaultValue with blocked characters at tool level", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.validateDefaultValue).mockImplementation((type: string, value: string) => {
      if (/[;{}\[\]\\]/.test(value)) {
        throw new Error("Invalid default value for column: contains blocked characters");
      }
    });

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", defaultValue: "abc}" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked characters");
  });

  it("rejects SQL comment markers in defaultValue at tool level", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(false);
    vi.mocked(litesql.validateDefaultValue).mockImplementation((type: string, value: string) => {
      if (value.includes("--") || value.includes("/*") || value.includes("*/")) {
        throw new Error("Invalid default value for column: SQL comment marker not allowed");
      }
    });

    const result = await (createTableTool as any).execute({
      tableName: "messages",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "message", type: "TEXT", defaultValue: "default -- comment" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("SQL comment marker");
  });
});
