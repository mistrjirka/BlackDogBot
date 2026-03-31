import { describe, it, expect, beforeEach } from "vitest";
import { createUpdateTableTool } from "../../../src/tools/update-table.tool.js";

describe("createUpdateTableTool", () => {
  it("creates tool with correct name format", () => {
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
    expect(tool.name).toBe("update_table_users");
  });

  it("excludes primary key from settable columns", () => {
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
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
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
    const schema = tool.schema as any;
    
    // Should fail validation when only 'where' is provided
    const result = schema.safeParse({ where: "id = 1" });
    expect(result.success).toBe(false);
  });

  it("allows setting multiple columns", async () => {
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
    const schema = tool.schema as any;
    
    const result = schema.safeParse({ 
      where: "id = 1", 
      name: "John", 
      email: "john@example.com" 
    });
    expect(result.success).toBe(true);
  });
});
