import { describe, it, expect } from "vitest";
import { convertOutputSchemaBlueprintToJsonSchema } from "../../src/utils/output-schema-blueprint.js";

describe("convertOutputSchemaBlueprintToJsonSchema", () => {
  it("converts object blueprint to strict object JSON Schema", () => {
    const schema = convertOutputSchemaBlueprintToJsonSchema({
      type: "object",
      fields: [
        { name: "title", type: "string" },
        { name: "score", type: "number" },
        { name: "verified", type: "boolean" },
      ],
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        score: { type: "number" },
        verified: { type: "boolean" },
      },
      required: ["title", "score", "verified"],
      additionalProperties: false,
    });
  });

  it("converts array blueprint to object with required items array", () => {
    const schema = convertOutputSchemaBlueprintToJsonSchema({
      type: "array",
      fields: [
        { name: "title", type: "string" },
        { name: "tags", type: "stringArray" },
      ],
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["title", "tags"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    });
  });
});


