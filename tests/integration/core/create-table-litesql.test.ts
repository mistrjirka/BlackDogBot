import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "path";
import os from "os";

import * as litesql from "../../../src/helpers/litesql.js";

describe("createTableAsync validation", () => {
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

  it("accepts valid TEXT default value with single quotes", async () => {
    await litesql.createTableAsync("testdb", "t1", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT", defaultValue: "'default_name'" },
    ]);
    const schema = await litesql.getTableSchemaAsync("testdb", "t1");
    expect(schema.columns[1].defaultValue).toBe("'default_name'");
  });

  it("accepts valid INTEGER default value", async () => {
    await litesql.createTableAsync("testdb", "t2", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "count", type: "INTEGER", defaultValue: "42" },
    ]);
    const schema = await litesql.getTableSchemaAsync("testdb", "t2");
    expect(schema.columns[1].defaultValue).toBe("42");
  });

  it("accepts valid REAL default value", async () => {
    await litesql.createTableAsync("testdb", "t3", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "price", type: "REAL", defaultValue: "3.14" },
    ]);
    const schema = await litesql.getTableSchemaAsync("testdb", "t3");
    expect(schema.columns[1].defaultValue).toBe("3.14");
  });

  it("rejects malformed TEXT default value with unmatched quote", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t4", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", defaultValue: "'unclosed" },
      ])
    ).rejects.toThrow();
  });

  it("rejects malformed default value with brace characters", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t6", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", defaultValue: "abc}" },
      ])
    ).rejects.toThrow();
  });

  it("rejects malformed default value with semicolons", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t7", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", defaultValue: "abc; DROP TABLE others" },
      ])
    ).rejects.toThrow();
  });

  it("accepts valid NULL default value", async () => {
    await litesql.createTableAsync("testdb", "t8", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT", defaultValue: "NULL" },
    ]);
    const schema = await litesql.getTableSchemaAsync("testdb", "t8");
    expect(schema.columns[1].defaultValue).toBe("NULL");
  });

  it("accepts valid CURRENT_TIMESTAMP default", async () => {
    await litesql.createTableAsync("testdb", "t9", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "created", type: "TEXT", defaultValue: "CURRENT_TIMESTAMP" },
    ]);
    const schema = await litesql.getTableSchemaAsync("testdb", "t9");
    expect(schema.columns[1].defaultValue).toBe("CURRENT_TIMESTAMP");
  });

  it("rejects INTEGER default with non-numeric string literal", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t10", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "count", type: "INTEGER", defaultValue: "abc" },
      ])
    ).rejects.toThrow(/INTEGER default must be a numeric literal/);
  });

  it("rejects INTEGER default with quoted numeric string", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t11", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "count", type: "INTEGER", defaultValue: "'42'" },
      ])
    ).rejects.toThrow(/INTEGER default must be a numeric literal/);
  });

  it("rejects REAL default with non-numeric string literal", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t12", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "price", type: "REAL", defaultValue: "abc" },
      ])
    ).rejects.toThrow(/REAL default must be a numeric literal/);
  });

  it("rejects REAL default with unmatched quote", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t13", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "price", type: "REAL", defaultValue: "'3.14" },
      ])
    ).rejects.toThrow();
  });

  it("accepts valid negative INTEGER default", async () => {
    await litesql.createTableAsync("testdb", "t14", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "temp", type: "INTEGER", defaultValue: "-5" },
    ]);
    const schema = await litesql.getTableSchemaAsync("testdb", "t14");
    expect(schema.columns[1].defaultValue).toBe("-5");
  });

  it("accepts valid REAL default with decimal point", async () => {
    await litesql.createTableAsync("testdb", "t15", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "ratio", type: "REAL", defaultValue: "0.123" },
    ]);
    const schema = await litesql.getTableSchemaAsync("testdb", "t15");
    expect(schema.columns[1].defaultValue).toBe("0.123");
  });

  it("rejects empty TEXT default to avoid invalid SQL DEFAULT clause", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t16", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", defaultValue: "" },
      ])
    ).rejects.toThrow(/empty string is not a valid default/i);
  });

  it("rejects empty INTEGER default", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t17", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "count", type: "INTEGER", defaultValue: "" },
      ])
    ).rejects.toThrow(/empty string is not a valid default/i);
  });

  it("rejects empty REAL default", async () => {
    await expect(
      litesql.createTableAsync("testdb", "t18", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "price", type: "REAL", defaultValue: "" },
      ])
    ).rejects.toThrow(/empty string is not a valid default/i);
  });
});
