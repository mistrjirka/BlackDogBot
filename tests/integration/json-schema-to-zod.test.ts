import { describe, it, expect } from "vitest";
import { jsonSchemaToZod, createOutputZodSchema } from "../../src/utils/json-schema-to-zod.js";

describe("jsonSchemaToZod", () => {
  describe("primitive types", () => {
    it("should convert string type", () => {
      const schema = { type: "string" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse("hello").success).toBe(true);
      expect(zodSchema.safeParse(123).success).toBe(false);
    });

    it("should convert number type", () => {
      const schema = { type: "number" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse(3.14).success).toBe(true);
      expect(zodSchema.safeParse("hello").success).toBe(false);
    });

    it("should convert integer type to number", () => {
      const schema = { type: "integer" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse("hello").success).toBe(false);
    });

    it("should convert boolean type", () => {
      const schema = { type: "boolean" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse(true).success).toBe(true);
      expect(zodSchema.safeParse(false).success).toBe(true);
      expect(zodSchema.safeParse("true").success).toBe(false);
    });

    it("should convert null type", () => {
      const schema = { type: "null" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse(null).success).toBe(true);
      expect(zodSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe("array types", () => {
    it("should convert array with items", () => {
      const schema = {
        type: "array",
        items: { type: "string" },
      };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse(["a", "b", "c"]).success).toBe(true);
      expect(zodSchema.safeParse([1, 2, 3]).success).toBe(false);
      expect(zodSchema.safeParse("not an array").success).toBe(false);
    });

    it("should convert array without items to unknown array", () => {
      const schema = { type: "array" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse([1, "a", true]).success).toBe(true);
      expect(zodSchema.safeParse("not an array").success).toBe(false);
    });

    it("should convert nested array", () => {
      const schema = {
        type: "array",
        items: {
          type: "array",
          items: { type: "number" },
        },
      };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse([[1, 2], [3, 4]]).success).toBe(true);
      expect(zodSchema.safeParse([[1, "a"]]).success).toBe(false);
    });
  });

  describe("object types", () => {
    it("should convert object with properties", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse({ name: "John", age: 30 }).success).toBe(true);
      expect(zodSchema.safeParse({ name: "John" }).success).toBe(true); // age is optional
      expect(zodSchema.safeParse({ age: 30 }).success).toBe(true); // name is optional
    });

    it("should handle required fields", () => {
      const schema = {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id"],
      };
      const zodSchema = jsonSchemaToZod(schema);

      // id is required
      expect(zodSchema.safeParse({ id: "123" }).success).toBe(true);
      expect(zodSchema.safeParse({ name: "John" }).success).toBe(false); // missing required id
      expect(zodSchema.safeParse({ id: "123", name: "John" }).success).toBe(true);
    });

    it("should convert nested objects", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse({ user: { name: "John", email: "john@example.com" } }).success).toBe(true);
      expect(zodSchema.safeParse({ user: { name: "John" } }).success).toBe(true);
    });

    it("should convert object without properties to record", () => {
      const schema = { type: "object" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse({ any: "thing" }).success).toBe(true);
      expect(zodSchema.safeParse("not an object").success).toBe(false);
    });
  });

  describe("union types", () => {
    it("should handle nullable types (union with null)", () => {
      const schema = {
        type: ["string", "null"],
      };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse("hello").success).toBe(true);
      expect(zodSchema.safeParse(null).success).toBe(true);
      expect(zodSchema.safeParse(123).success).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should return z.unknown() for null/undefined schema", () => {
      const zodSchema1 = jsonSchemaToZod(null);
      const zodSchema2 = jsonSchemaToZod(undefined);

      expect(zodSchema1.safeParse("anything").success).toBe(true);
      expect(zodSchema2.safeParse({ any: "thing" }).success).toBe(true);
    });

    it("should return z.unknown() for unknown type", () => {
      const schema = { type: "unknownType" };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse("anything").success).toBe(true);
    });

    it("should infer object type from properties even without type field", () => {
      const schema = {
        properties: {
          name: { type: "string" },
        },
      };
      const zodSchema = jsonSchemaToZod(schema);

      expect(zodSchema.safeParse({ name: "John" }).success).toBe(true);
    });
  });
});

describe("createOutputZodSchema", () => {
  it("should return record schema for null/undefined input", () => {
    const zodSchema = createOutputZodSchema(null);

    expect(zodSchema.safeParse({ any: "thing" }).success).toBe(true);
  });

  it("should return object schema for valid object schema input", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        count: { type: "number" },
      },
      required: ["items"],
    };

    const zodSchema = createOutputZodSchema(schema);

    // Valid input
    expect(
      zodSchema.safeParse({
        items: [{ id: "1", name: "Item 1" }],
        count: 1,
      }).success,
    ).toBe(true);

    // Missing required field
    expect(zodSchema.safeParse({ count: 1 }).success).toBe(false);

    // Wrong type
    expect(
      zodSchema.safeParse({
        items: "not an array",
      }).success,
    ).toBe(false);
  });

  it("should handle complex nested schema like agent output", () => {
    const schema = {
      type: "object",
      properties: {
        interesting_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              link: { type: "string" },
              description: { type: "string" },
              is_verified: { type: "number" },
              verification_notes: { type: "string" },
            },
            required: ["title", "link"],
          },
        },
      },
      required: ["interesting_items"],
    };

    const zodSchema = createOutputZodSchema(schema);

    // Valid input
    const validInput = {
      interesting_items: [
        {
          title: "Breaking News",
          link: "https://example.com/1",
          description: "A description",
          is_verified: 1,
          verification_notes: "Verified source",
        },
      ],
    };

    expect(zodSchema.safeParse(validInput).success).toBe(true);

    // Missing required nested field
    const invalidInput = {
      interesting_items: [
        {
          title: "Breaking News",
          // missing link
        },
      ],
    };

    expect(zodSchema.safeParse(invalidInput).success).toBe(false);
  });
});
