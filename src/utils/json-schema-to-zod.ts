import { z } from "zod";

/**
 * Converts a JSON Schema object to a Zod schema at runtime.
 * Supports a subset of JSON Schema features commonly used in agent node outputs.
 *
 * Supported types:
 * - string, number, integer, boolean, null
 * - array (with items)
 * - object (with properties)
 * - required fields
 * - optional fields (not in required array)
 * - nested objects and arrays
 *
 * Not supported:
 * - $ref, $schema, definitions
 * - Pattern matching, min/max length, enum
 * - OneOf, anyOf, allOf
 */

type JsonSchema = Record<string, unknown>;

/**
 * Converts a JSON Schema to a Zod schema.
 * Returns z.unknown() for unsupported or invalid schemas.
 */
export function jsonSchemaToZod(schema: JsonSchema | undefined | null): z.ZodType {
  if (!schema || typeof schema !== "object") {
    return z.unknown();
  }

  const type: unknown = schema.type;

  // Handle union types (type: ["string", "null"])
  if (Array.isArray(type)) {
    return handleUnionType(schema, type);
  }

  switch (type) {
    case "string":
      return z.string();

    case "number":
    case "integer":
      return z.number();

    case "boolean":
      return z.boolean();

    case "null":
      return z.null();

    case "array":
      return handleArraySchema(schema);

    case "object":
      return handleObjectSchema(schema);

    default:
      // If no type is specified, try to infer from properties
      if (schema.properties && typeof schema.properties === "object") {
        return handleObjectSchema(schema);
      }

      return z.unknown();
  }
}

/**
 * Handles union types like ["string", "null"] which means optional/nullable.
 */
function handleUnionType(schema: JsonSchema, types: string[]): z.ZodType {
  // Filter out null to get the base type
  const nonNullTypes: string[] = types.filter((t) => t !== "null");
  const isNullable: boolean = types.includes("null");

  if (nonNullTypes.length === 0) {
    return z.null();
  }

  // Get the base schema for the non-null type
  const baseSchema: z.ZodType = jsonSchemaToZod({ ...schema, type: nonNullTypes[0] });

  if (isNullable) {
    return baseSchema.nullable();
  }

  return baseSchema;
}

/**
 * Handles array schemas with items definition.
 */
function handleArraySchema(schema: JsonSchema): z.ZodType {
  const items: unknown = schema.items;

  if (!items || typeof items !== "object") {
    // Array without items definition - accept any array
    return z.array(z.unknown());
  }

  const itemSchema: z.ZodType = jsonSchemaToZod(items as JsonSchema);

  return z.array(itemSchema);
}

/**
 * Handles object schemas with properties definition.
 */
function handleObjectSchema(schema: JsonSchema): z.ZodType {
  const properties: unknown = schema.properties;
  const required: unknown = schema.required;

  if (!properties || typeof properties !== "object") {
    // Object without properties - accept any object
    return z.record(z.string(), z.unknown());
  }

  const requiredSet: Set<string> = new Set(
    Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [],
  );

  const shape: Record<string, z.ZodType> = {};

  for (const [key, propSchema] of Object.entries(properties as Record<string, JsonSchema>)) {
    const zodSchema: z.ZodType = jsonSchemaToZod(propSchema);

    if (requiredSet.has(key)) {
      shape[key] = zodSchema;
    } else {
      // Optional field
      shape[key] = zodSchema.optional();
    }
  }

  return z.object(shape as z.ZodRawShape);
}

/**
 * Creates a Zod schema from JSON Schema that accepts Record<string, unknown>.
 * This is the main entry point for agent node output validation.
 *
 * @param schema - The JSON Schema to convert
 * @returns A Zod schema that validates objects matching the schema
 */
export function createOutputZodSchema(schema: JsonSchema | undefined | null): z.ZodType<Record<string, unknown>> {
  if (!schema) {
    // No schema provided - accept any object
    return z.record(z.string(), z.unknown());
  }

  const zodSchema: z.ZodType = jsonSchemaToZod(schema);

  // Ensure the schema is for an object
  if (zodSchema instanceof z.ZodObject) {
    return zodSchema as z.ZodType<Record<string, unknown>>;
  }

  // If it's not an object schema, wrap it in an object with a "result" key
  // This handles edge cases where the schema might be something else
  return z.record(z.string(), z.unknown());
}
