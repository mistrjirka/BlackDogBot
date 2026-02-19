import { describe, it, expect } from "vitest";

import {
  checkSchemaCompatibility,
  validateDataAgainstSchema,
} from "../../src/jobs/schema-compat.js";

//#region Tests

describe("schema-compat", () => {
  describe("checkSchemaCompatibility", () => {
    it("should pass when output has all required input fields", () => {
      const outputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      };

      const inputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      };

      const result = checkSchemaCompatibility(outputSchema, inputSchema);

      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail when required input field is missing from output", () => {
      const outputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          age: { type: "number" },
        },
      };

      const inputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      };

      const result = checkSchemaCompatibility(outputSchema, inputSchema);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
    });

    it("should fail on type mismatch", () => {
      const outputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          count: { type: "string" },
        },
      };

      const inputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          count: { type: "number" },
        },
        required: ["count"],
      };

      const result = checkSchemaCompatibility(outputSchema, inputSchema);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e: string) => e.includes("type mismatch"))).toBe(true);
    });

    it("should pass when both schemas are null/empty", () => {
      const result = checkSchemaCompatibility(
        null as unknown as Record<string, unknown>,
        null as unknown as Record<string, unknown>,
      );

      expect(result.compatible).toBe(true);
    });
  });

  describe("validateDataAgainstSchema", () => {
    it("should validate valid data", () => {
      const schema: Record<string, unknown> = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      };

      const data: Record<string, unknown> = { name: "Alice", age: 30 };

      const result = validateDataAgainstSchema(data, schema);

      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail on missing required field", () => {
      const schema: Record<string, unknown> = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      };

      const data: Record<string, unknown> = { age: 30 };

      const result = validateDataAgainstSchema(data, schema);

      expect(result.compatible).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should fail on wrong type", () => {
      const schema: Record<string, unknown> = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      };

      const data: Record<string, unknown> = { name: 123 };

      const result = validateDataAgainstSchema(data, schema);

      expect(result.compatible).toBe(false);
    });

    it("should pass with empty schema", () => {
      const result = validateDataAgainstSchema({ anything: "goes" }, {});

      expect(result.compatible).toBe(true);
    });

    it("should return error when schema compilation fails due to invalid schema", () => {
      // Passing a schema with a $ref that cannot be resolved forces AJV to throw on compile
      const invalidSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          name: { $ref: "#/definitions/DoesNotExist" },
        },
      };

      const result = validateDataAgainstSchema({ name: "Alice" }, invalidSchema);

      expect(result.compatible).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Schema compilation failed");
    });
  });

  describe("checkSchemaCompatibility - field overlap without type info", () => {
    it("should pass when overlapping field has no type on output side", () => {
      // The type mismatch branch is only entered when both fields have a type property.
      // When output field lacks type, the branch should be skipped and compatibility passes.
      const outputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          value: { description: "no type here" },
        },
      };

      const inputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      };

      const result = checkSchemaCompatibility(outputSchema, inputSchema);

      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass when overlapping field has no type on input side", () => {
      // Same branch guard — input field lacks type, so no comparison is made.
      const outputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      };

      const inputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          value: { description: "no type here" },
        },
      };

      const result = checkSchemaCompatibility(outputSchema, inputSchema);

      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});

//#endregion Tests
