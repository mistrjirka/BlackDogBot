import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as litesql from "../../../src/helpers/litesql.js";

describe("litesql queryTableAsync pagination", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "litesql-query-test-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    await litesql.createDatabaseAsync("blackdog");
    await litesql.createTableAsync("blackdog", "items", [
      { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
      { name: "name", type: "TEXT", notNull: true },
    ]);

    await litesql.insertIntoTableAsync("blackdog", "items", Array.from({ length: 10 }).map((_v, i) => {
      return {
        id: i + 1,
        name: `item-${i + 1}`,
      };
    }));
  });

  it("applies offset and keeps totalCount as full match count", async () => {
    const result = await litesql.queryTableAsync("blackdog", "items", {
      orderBy: "id ASC",
      limit: 3,
      offset: 4,
    });

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].id).toBe(5);
    expect(result.rows[1].id).toBe(6);
    expect(result.rows[2].id).toBe(7);
    expect(result.totalCount).toBe(10);
  });
});
