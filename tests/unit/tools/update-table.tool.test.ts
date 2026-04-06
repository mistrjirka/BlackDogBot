import { describe, it, expect, beforeEach } from "vitest";
import { createUpdateTableTool } from "../../../src/tools/update-table.tool.js";
import type { IColumnInfo } from "../../../src/helpers/litesql.js";

describe("createUpdateTableTool", () => {
  it("creates tool with correct name format", () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      { name: "email", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
    ];
    const tool = createUpdateTableTool("users", columns, "testdb");
    expect(tool.name).toBe("update_table_users");
  });

  it("excludes primary key from settable columns", () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      { name: "email", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
    ];
    const tool = createUpdateTableTool("users", columns, "testdb");
    const schema = tool.schema as any;
    const innerSchema = schema._def.schema;
    const shape = innerSchema.shape;

    // 'where' should exist
    expect(shape.where).toBeDefined();

    // 'name' and 'email' should exist as optional params
    expect(shape.name).toBeDefined();
    expect(shape.email).toBeDefined();

    // 'id' should NOT exist as settable param
    expect(shape.id).toBeUndefined();
  });

  it("requires at least one column to be set", async () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      { name: "email", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
    ];
    const tool = createUpdateTableTool("users", columns, "testdb");
    const schema = tool.schema as any;

    // Should fail validation when only 'where' is provided
    const result = schema.safeParse({ where: "id = 1" });
    expect(result.success).toBe(false);
  });

  it("allows setting multiple columns", async () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      { name: "email", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
    ];
    const tool = createUpdateTableTool("users", columns, "testdb");
    const schema = tool.schema as any;

    const result = schema.safeParse({
      where: "id = 1",
      name: "John",
      email: "john@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("maps TEXT columns to z.string() schema type", () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
    ];
    const tool = createUpdateTableTool("users", columns, "testdb");
    const schema = tool.schema as any;
    const shape = schema._def.schema.shape;

    // TEXT column should accept strings
    const stringResult = shape.name.safeParse("hello");
    expect(stringResult.success).toBe(true);

    // TEXT column should reject numbers
    const numberResult = shape.name.safeParse(42);
    expect(numberResult.success).toBe(false);

    // TEXT column should reject booleans (the production bug)
    const boolResult = shape.name.safeParse(false);
    expect(boolResult.success).toBe(false);
  });

  it("maps INTEGER columns to z.number() schema type", () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "score", type: "INTEGER", notNull: false, primaryKey: false, defaultValue: null },
    ];
    const tool = createUpdateTableTool("scores", columns, "testdb");
    const schema = tool.schema as any;
    const shape = schema._def.schema.shape;

    // INTEGER column should accept numbers
    const numberResult = shape.score.safeParse(42);
    expect(numberResult.success).toBe(true);

    // INTEGER column should reject strings
    const stringResult = shape.score.safeParse("42");
    expect(stringResult.success).toBe(false);

    // INTEGER column should reject booleans
    const boolResult = shape.score.safeParse(true);
    expect(boolResult.success).toBe(false);
  });

  it("maps REAL columns to z.number() schema type", () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "price", type: "REAL", notNull: false, primaryKey: false, defaultValue: null },
    ];
    const tool = createUpdateTableTool("products", columns, "testdb");
    const schema = tool.schema as any;
    const shape = schema._def.schema.shape;

    // REAL column should accept floating point numbers
    const numberResult = shape.price.safeParse(19.99);
    expect(numberResult.success).toBe(true);

    // REAL column should reject strings
    const stringResult = shape.price.safeParse("19.99");
    expect(stringResult.success).toBe(false);
  });

  it("includes column type info in describe() for LLM context", () => {
    const columns: IColumnInfo[] = [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false, defaultValue: null },
      { name: "score", type: "INTEGER", notNull: false, primaryKey: false, defaultValue: "0" },
    ];
    const tool = createUpdateTableTool("users", columns, "testdb");
    const schema = tool.schema as any;
    const shape = schema._def.schema.shape;

    // Description should mention the column type
    const nameDesc = shape.name._def.description ?? "";
    expect(nameDesc.toLowerCase()).toContain("text");

    const scoreDesc = shape.score._def.description ?? "";
    expect(scoreDesc.toLowerCase()).toContain("integer");
  });
});
