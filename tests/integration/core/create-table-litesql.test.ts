import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "path";
import os from "os";

import * as litesql from "../../../src/helpers/litesql.js";

describe("createTableAsync defaultValue policy", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "litesql-test-"));
    originalHome = process.env.HOME ?? "";
    process.env.HOME = tempDir;
    await fs.promises.mkdir(path.join(tempDir, ".blackdogbot", "databases"), { recursive: true });
    await litesql.createDatabaseAsync("testdb");
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("rejects defaultValue for TEXT columns", async () => {
    const columnsWithDefault = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT", defaultValue: "'default_name'" },
    ] as unknown as { name: string; type: string; primaryKey?: boolean; notNull?: boolean }[];

    await expect(
      litesql.createTableAsync("testdb", "t1", columnsWithDefault)
    ).rejects.toThrow(/defaultValue is no longer supported/i);
  });

  it("rejects defaultValue for INTEGER columns", async () => {
    const columnsWithDefault = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "count", type: "INTEGER", defaultValue: "42" },
    ] as unknown as { name: string; type: string; primaryKey?: boolean; notNull?: boolean }[];

    await expect(
      litesql.createTableAsync("testdb", "t2", columnsWithDefault)
    ).rejects.toThrow(/defaultValue is no longer supported/i);
  });

  it("creates table successfully when no defaults are provided", async () => {
    await litesql.createTableAsync("testdb", "t3", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT", notNull: true },
    ]);

    const schema = await litesql.getTableSchemaAsync("testdb", "t3");
    expect(schema.columns[1].defaultValue).toBeNull();
  });
});
