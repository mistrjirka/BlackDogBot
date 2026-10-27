import { describe, expect, it } from "vitest";
import {
  readFileToolInputSchema, readImageToolInputSchema, writeFileToolInputSchema, appendFileToolInputSchema,
} from "../../src/shared/schemas/tool-schemas.js";

describe("file tools require a real path", () => {
  for (const [name, schema, payload] of [
    ["read_file", readFileToolInputSchema, {}],
    ["read_image", readImageToolInputSchema, {}],
    ["write_file", writeFileToolInputSchema, { content: "hello" }],
    ["append_file", appendFileToolInputSchema, { content: "hello" }],
  ] as const) {
    it(`${name} rejects omitted, empty, and whitespace-only paths`, () => {
      expect(schema.safeParse(payload).success).toBe(false);
      expect(schema.safeParse({ ...payload, filePath: "" }).success).toBe(false);
      expect(schema.safeParse({ ...payload, filePath: "   " }).success).toBe(false);
      expect(schema.safeParse({ ...payload, filePath: "/tmp/fetch.py" }).success).toBe(true);
      expect(schema.safeParse({ ...payload, filePath: "notes.txt" }).success).toBe(true);
    });
  }
});
