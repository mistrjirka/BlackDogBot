import { beforeEach, describe, expect, it, vi } from "vitest";

import * as litesql from "../../../src/helpers/litesql.js";
import { buildReadFromDatabaseTool } from "../../../src/tools/read-from-database.tool.js";

vi.mock("../../../src/helpers/litesql.js");

describe("buildReadFromDatabaseTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects SQL clauses inside where", async () => {
    const tool = buildReadFromDatabaseTool(["news_items"]);

    await expect(
      (tool.execute as any)({
        tableName: "news_items",
        where: "is_interesting = 1 ORDER BY pub_date DESC LIMIT 10",
      }),
    ).rejects.toThrow(/where must contain only filter predicates/i);
  });

  it("rejects SQL clauses inside orderBy", async () => {
    const tool = buildReadFromDatabaseTool(["news_items"]);

    await expect(
      (tool.execute as any)({
        tableName: "news_items",
        orderBy: "pub_date DESC LIMIT 10",
      }),
    ).rejects.toThrow(/orderBy must contain only column names and ASC\/DESC/i);
  });

  it("rejects limit above 50", async () => {
    const tool = buildReadFromDatabaseTool(["news_items"]);

    await expect(
      (tool.execute as any)({
        tableName: "news_items",
        limit: 51,
      }),
    ).rejects.toThrow(/less than or equal to 50/i);
  });

  it("rejects negative offset", async () => {
    const tool = buildReadFromDatabaseTool(["news_items"]);

    await expect(
      (tool.execute as any)({
        tableName: "news_items",
        offset: -1,
      }),
    ).rejects.toThrow(/greater than or equal to 0/i);
  });

  it("rejects unknown fields due to strict schema", async () => {
    const tool = buildReadFromDatabaseTool(["news_items"]);

    await expect(
      (tool.execute as any)({
        tableName: "news_items",
        badField: true,
      }),
    ).rejects.toThrow(/unrecognized key/i);
  });

  it("rejects unknown column names in columns[]", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.getTableSchemaAsync).mockResolvedValue({
      name: "news_items",
      columns: [
        { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
        { name: "title", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ],
    });

    const tool = buildReadFromDatabaseTool(["news_items"]);

    await expect(
      (tool.execute as any)({
        tableName: "news_items",
        columns: ["id", "missing_column"],
      }),
    ).rejects.toThrow(/unknown columns requested: missing_column/i);
  });

  it("accepts valid query and forwards to litesql", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.getTableSchemaAsync).mockResolvedValue({
      name: "news_items",
      columns: [
        { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
        { name: "title", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
        { name: "pub_date", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      ],
    });
    vi.mocked(litesql.queryTableAsync).mockResolvedValue({
      rows: [{ id: 1, title: "hello", pub_date: "2026-04-13" }],
      totalCount: 1,
    });

    const tool = buildReadFromDatabaseTool(["news_items"]);

    const result = await (tool.execute as any)({
      tableName: "news_items",
      where: "id >= 1",
      orderBy: "pub_date DESC",
      limit: 50,
      offset: 20,
      columns: ["id", "title", "pub_date"],
    });

    expect(litesql.queryTableAsync).toHaveBeenCalledWith("blackdog", "news_items", {
      where: "id >= 1",
      orderBy: "pub_date DESC",
      limit: 50,
      offset: 20,
      columns: ["id", "title", "pub_date"],
    });
    expect(result.returnedCount).toBe(1);
    expect(result.matchingTotal).toBe(1);
    expect(result.remainingCount).toBe(0);
    expect(result.nextOffset).toBeNull();
    expect(result.continuationHint).toContain("1 items read");
  });

  it("uses default limit from env and returns continuation metadata", async () => {
    vi.stubEnv("BLACKDOGBOT_READ_DB_DEFAULT_LIMIT", "20");
    vi.resetModules();

    const { buildReadFromDatabaseTool: buildToolWithEnvDefault } = await import("../../../src/tools/read-from-database.tool.js");

    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.tableExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.getTableSchemaAsync).mockResolvedValue({
      name: "news_items",
      columns: [
        { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      ],
    });
    vi.mocked(litesql.queryTableAsync).mockResolvedValue({
      rows: Array.from({ length: 20 }).map((_v, i) => ({ id: i + 1 })),
      totalCount: 75,
    });

    const tool = buildToolWithEnvDefault(["news_items"]);

    const result = await (tool.execute as any)({
      tableName: "news_items",
    });

    expect(litesql.queryTableAsync).toHaveBeenCalledWith("blackdog", "news_items", {
      where: undefined,
      orderBy: undefined,
      limit: 20,
      offset: 0,
      columns: undefined,
    });
    expect(result.returnedCount).toBe(20);
    expect(result.matchingTotal).toBe(75);
    expect(result.remainingCount).toBe(55);
    expect(result.nextOffset).toBe(20);
    expect(result.continuationHint).toContain("20 items read, 55 remaining");

    vi.unstubAllEnvs();
  });
});
