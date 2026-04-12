import { beforeEach, describe, expect, it, vi } from "vitest";

import * as litesql from "../../../src/helpers/litesql.js";
import { buildPerTableToolsAsync, buildUpdateTableToolsAsync } from "../../../src/utils/per-table-tools.js";
import { resetSingletons } from "../../utils/test-helpers.js";

vi.mock("../../../src/helpers/litesql.js");

describe("buildPerTableToolsAsync", () => {
  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("returns empty ToolSet when no tables exist", async () => {
    vi.mocked(litesql.safeListTablesAsync).mockResolvedValue({ tables: [], status: "ok" });

    const result = await buildPerTableToolsAsync();

    expect(result.tools).toEqual({});
    expect(result.dbStatus).toBe("ok");
  });

  it("builds write_table_ tool for each table", async () => {
    vi.mocked(litesql.safeListTablesAsync).mockResolvedValue({ tables: ["users", "articles"], status: "ok" });
    vi.mocked(litesql.safeGetTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      if (table === "users") {
        return {
          schema: {
            name: "users",
            columns: [
              { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
              { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
            ],
          },
          status: "ok",
        };
      }
      return {
        schema: {
          name: "articles",
          columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
            { name: "title", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
          ],
        },
        status: "ok",
      };
    });

    const result = await buildPerTableToolsAsync();

    expect(Object.keys(result.tools)).toHaveLength(2);
    expect(result.tools).toHaveProperty("write_table_users");
    expect(result.tools).toHaveProperty("write_table_articles");
  });

  it("dynamically discovers NEW tables that were created after cron task was created", async () => {
    vi.mocked(litesql.safeListTablesAsync)
      .mockResolvedValueOnce({ tables: ["articles"], status: "ok" })
      .mockResolvedValueOnce({ tables: ["articles", "new_table"], status: "ok" });

    vi.mocked(litesql.safeGetTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      return {
        schema: {
          name: table,
          columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
            { name: "name", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
          ],
        },
        status: "ok",
      };
    });

    const result1 = await buildPerTableToolsAsync();
    expect(Object.keys(result1.tools)).toEqual(["write_table_articles"]);

    const result2 = await buildPerTableToolsAsync();
    expect(Object.keys(result2.tools)).toContain("write_table_new_table");
    expect(Object.keys(result2.tools)).toContain("write_table_articles");
  });

  it("auto-fills missing required date-like columns and accepts 'now' for date-like inputs", async () => {
    vi.mocked(litesql.safeListTablesAsync).mockResolvedValue({ tables: ["events"], status: "ok" });
    vi.mocked(litesql.safeGetTableSchemaAsync).mockResolvedValue({
      schema: {
        name: "events",
        columns: [
          { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
          { name: "title", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
          { name: "created_at", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
          { name: "updated_at", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        ],
      },
      status: "ok",
    });

    vi.mocked(litesql.insertIntoTableAsync).mockResolvedValue({ insertedCount: 1, lastRowId: 1 });

    const result = await buildPerTableToolsAsync();
    const tool = result.tools["write_table_events"] as any;

    await tool.execute({
      data: [
        { title: "hello", updated_at: "now" },
      ],
    });

    expect(litesql.insertIntoTableAsync).toHaveBeenCalledTimes(1);
    const insertedRows = vi.mocked(litesql.insertIntoTableAsync).mock.calls[0][2] as Record<string, unknown>[];
    expect(insertedRows[0].title).toBe("hello");
    expect(typeof insertedRows[0].created_at).toBe("string");
    expect((insertedRows[0].created_at as string)).toContain("T");
    expect(typeof insertedRows[0].updated_at).toBe("string");
    expect((insertedRows[0].updated_at as string)).toContain("T");
    expect(insertedRows[0].updated_at).not.toBe("now");
  });

  it("auto-fills required DATETIME columns even when column name is not a common timestamp name", async () => {
    vi.mocked(litesql.safeListTablesAsync).mockResolvedValue({ tables: ["events"], status: "ok" });
    vi.mocked(litesql.safeGetTableSchemaAsync).mockResolvedValue({
      schema: {
        name: "events",
        columns: [
          { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
          { name: "title", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
          { name: "logged_when", type: "DATETIME", notNull: true, primaryKey: false, defaultValue: null },
        ],
      },
      status: "ok",
    });

    vi.mocked(litesql.insertIntoTableAsync).mockResolvedValue({ insertedCount: 1, lastRowId: 1 });

    const result = await buildPerTableToolsAsync();
    const tool = result.tools["write_table_events"] as any;

    await tool.execute({
      data: [
        { title: "hello" },
      ],
    });

    const insertedRows = vi.mocked(litesql.insertIntoTableAsync).mock.calls[0][2] as Record<string, unknown>[];
    expect(typeof insertedRows[0].logged_when).toBe("string");
    expect((insertedRows[0].logged_when as string)).toContain("T");
  });
});

describe("buildUpdateTableToolsAsync", () => {
  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("returns empty ToolSet when no tables exist", async () => {
    vi.mocked(litesql.safeListTablesAsync).mockResolvedValue({ tables: [], status: "ok" });

    const result = await buildUpdateTableToolsAsync();

    expect(result.tools).toEqual({});
    expect(result.dbStatus).toBe("ok");
  });

  it("builds update_table_ tool for each table", async () => {
    vi.mocked(litesql.safeListTablesAsync).mockResolvedValue({ tables: ["users", "articles"], status: "ok" });
    vi.mocked(litesql.safeGetTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      if (table === "users") {
        return {
          schema: {
            name: "users",
            columns: [
              { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
              { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
            ],
          },
          status: "ok",
        };
      }
      return {
        schema: {
          name: "articles",
          columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
            { name: "title", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
          ],
        },
        status: "ok",
      };
    });

    const result = await buildUpdateTableToolsAsync();

    expect(Object.keys(result.tools)).toHaveLength(2);
    expect(result.tools).toHaveProperty("update_table_users");
    expect(result.tools).toHaveProperty("update_table_articles");
  });

  it("dynamically discovers NEW tables that were created after cron task was created", async () => {
    vi.mocked(litesql.safeListTablesAsync)
      .mockResolvedValueOnce({ tables: ["articles"], status: "ok" })
      .mockResolvedValueOnce({ tables: ["articles", "new_table"], status: "ok" });

    vi.mocked(litesql.safeGetTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      return {
        schema: {
          name: table,
          columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
            { name: "name", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
          ],
        },
        status: "ok",
      };
    });

    const result1 = await buildUpdateTableToolsAsync();
    expect(Object.keys(result1.tools)).toEqual(["update_table_articles"]);

    const result2 = await buildUpdateTableToolsAsync();
    expect(Object.keys(result2.tools)).toContain("update_table_new_table");
    expect(Object.keys(result2.tools)).toContain("update_table_articles");
  });
});
