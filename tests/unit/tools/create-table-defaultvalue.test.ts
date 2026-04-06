import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as litesql from "../../../src/helpers/litesql.js";

describe("createTableAsync with defaultValue edge cases", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "create-table-test-"));
    originalHome = process.env.HOME ?? "";
    process.env.HOME = tempDir;
    await fs.mkdir(path.join(tempDir, ".blackdogbot", "databases"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should handle empty string defaultValue without SQL error", async () => {
    await litesql.createDatabaseAsync("test_db");

    // This should NOT throw a syntax error
    await litesql.createTableAsync("test_db", "test_table", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "status", type: "TEXT", defaultValue: "" },
      { name: "name", type: "TEXT" },
    ]);

    const exists = await litesql.tableExistsAsync("test_db", "test_table");
    expect(exists).toBe(true);
  });

  it("should handle non-empty string defaultValue", async () => {
    await litesql.createDatabaseAsync("test_db2");

    await litesql.createTableAsync("test_db2", "test_table", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "status", type: "TEXT", defaultValue: "pending" },
      { name: "count", type: "INTEGER", defaultValue: "0" },
    ]);

    const exists = await litesql.tableExistsAsync("test_db2", "test_table");
    expect(exists).toBe(true);
  });

  it("should handle undefined defaultValue", async () => {
    await litesql.createDatabaseAsync("test_db3");

    await litesql.createTableAsync("test_db3", "test_table", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT" },
    ]);

    const exists = await litesql.tableExistsAsync("test_db3", "test_table");
    expect(exists).toBe(true);
  });

  it("should handle multiple columns with empty string defaults", async () => {
    await litesql.createDatabaseAsync("test_db4");

    // This is the exact scenario from production
    await litesql.createTableAsync("test_db4", "news_items", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT" },
      { name: "content", type: "TEXT" },
      { name: "url", type: "TEXT" },
      { name: "pub_date", type: "TEXT" },
      { name: "feed_url", type: "TEXT" },
      { name: "source_id", type: "INTEGER" },
      { name: "verification_status", type: "TEXT", defaultValue: "pending" },
      { name: "summary", type: "TEXT", defaultValue: "" },
      { name: "merged_story", type: "TEXT", defaultValue: "" },
    ]);

    const exists = await litesql.tableExistsAsync("test_db4", "news_items");
    expect(exists).toBe(true);
  });
});
