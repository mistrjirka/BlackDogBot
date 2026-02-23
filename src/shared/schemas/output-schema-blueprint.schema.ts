import { z } from "zod";

export const outputSchemaBlueprintFieldSchema = z.object({
  name: z.string()
    .trim()
    .min(1),
  type: z.enum(["string", "number", "boolean", "stringArray", "numberArray"]),
}).strict();

export const outputSchemaBlueprintSchema = z.object({
  type: z.enum(["object", "array"]),
  fields: z.array(outputSchemaBlueprintFieldSchema)
    .min(1)
    .refine(
      (fields) => new Set(fields.map((f) => f.name)).size === fields.length,
      { message: "Field names must be unique" },
    ),
}).strict();

export type IOutputSchemaBlueprint = z.infer<typeof outputSchemaBlueprintSchema>;