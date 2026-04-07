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
    vi.mocked(litesql.listTablesAsync).mockResolvedValue([]);

    const result = await buildPerTableToolsAsync();

    expect(result).toEqual({});
  });

  it("builds write_table_ tool for each table", async () => {
    vi.mocked(litesql.listTablesAsync).mockResolvedValue(["users", "articles"]);
    vi.mocked(litesql.getTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      if (table === "users") {
        return {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
            { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
          ],
        };
      }
      return {
        name: "articles",
        columns: [
          { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
          { name: "title", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
        ],
      };
    });

    const result = await buildPerTableToolsAsync();

    expect(Object.keys(result)).toHaveLength(2);
    expect(result).toHaveProperty("write_table_users");
    expect(result).toHaveProperty("write_table_articles");
  });

  it("dynamically discovers NEW tables that were created after cron task was created", async () => {
    // Initially only articles table exists
    vi.mocked(litesql.listTablesAsync)
      .mockResolvedValueOnce(["articles"])
      .mockResolvedValueOnce(["articles", "new_table"]); // Simulating new table creation

    vi.mocked(litesql.getTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      return {
        name: table,
        columns: [
          { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
          { name: "name", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
        ],
      };
    });

    // First call - initial state
    const result1 = await buildPerTableToolsAsync();
    expect(Object.keys(result1)).toEqual(["write_table_articles"]);

    // Second call - after new table was created
    const result2 = await buildPerTableToolsAsync();
    expect(Object.keys(result2)).toContain("write_table_new_table");
    expect(Object.keys(result2)).toContain("write_table_articles");
  });
});

describe("buildUpdateTableToolsAsync", () => {
  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("returns empty ToolSet when no tables exist", async () => {
    vi.mocked(litesql.listTablesAsync).mockResolvedValue([]);

    const result = await buildUpdateTableToolsAsync();

    expect(result).toEqual({});
  });

  it("builds update_table_ tool for each table", async () => {
    vi.mocked(litesql.listTablesAsync).mockResolvedValue(["users", "articles"]);
    vi.mocked(litesql.getTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      if (table === "users") {
        return {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
            { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
          ],
        };
      }
      return {
        name: "articles",
        columns: [
          { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
          { name: "title", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
        ],
      };
    });

    const result = await buildUpdateTableToolsAsync();

    expect(Object.keys(result)).toHaveLength(2);
    expect(result).toHaveProperty("update_table_users");
    expect(result).toHaveProperty("update_table_articles");
  });

  it("dynamically discovers NEW tables that were created after cron task was created", async () => {
    // Initially only articles table exists
    vi.mocked(litesql.listTablesAsync)
      .mockResolvedValueOnce(["articles"])
      .mockResolvedValueOnce(["articles", "new_table"]); // Simulating new table creation

    vi.mocked(litesql.getTableSchemaAsync).mockImplementation(async (_db: string, table: string) => {
      return {
        name: table,
        columns: [
          { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
          { name: "name", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
        ],
      };
    });

    // First call - initial state
    const result1 = await buildUpdateTableToolsAsync();
    expect(Object.keys(result1)).toEqual(["update_table_articles"]);

    // Second call - after new table was created
    const result2 = await buildUpdateTableToolsAsync();
    expect(Object.keys(result2)).toContain("update_table_new_table");
    expect(Object.keys(result2)).toContain("update_table_articles");
  });
});
