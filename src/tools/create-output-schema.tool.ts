import { z } from "zod";
import { AiProviderService } from "../services/ai-provider.service.js";
import { LoggerService } from "../services/logger.service.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";

const SYSTEM_PROMPT: string = `You are a schema planner. Your job is to produce a strict JSON field blueprint that will be converted to JSON Schema by the app.

## Rules
1. Output ONLY the blueprint format requested by the schema.
2. Use these types only: "string", "number", "integer", "boolean", "array", "object", "null".
3. For object fields, use "objectFields".
4. For array fields, set "arrayItemType" and when item type is "object", provide "arrayItemObjectFields".
5. If a field is optional, set "required": false.
6. Include clear descriptions whenever possible.
7. Preserve explicitly requested field names exactly as written.
8. Do NOT invent wrapper/container top-level fields unless explicitly requested.

Example blueprint:
{
  "fields": [
    { "name": "title", "type": "string", "description": "Title", "required": true },
    { "name": "count", "type": "number", "description": "Count", "required": false },
    {
      "name": "items",
      "type": "array",
      "required": true,
      "arrayItemType": "object",
      "arrayItemObjectFields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "name", "type": "string", "required": true }
      ]
    }
  ]
}`;

type JsonScalarType = "string" | "number" | "integer" | "boolean" | "null";
type JsonFieldType = JsonScalarType | "array" | "object";

interface IScalarFieldBlueprint {
  name: string;
  type: JsonScalarType;
  description?: string | null;
  required?: boolean | null;
}

interface IMidFieldBlueprint {
  name: string;
  type: JsonFieldType;
  description?: string | null;
  required?: boolean | null;
  objectFields?: IScalarFieldBlueprint[] | null;
  arrayItemType?: JsonScalarType | "object" | null;
  arrayItemObjectFields?: IScalarFieldBlueprint[] | null;
}

interface ITopFieldBlueprint {
  name: string;
  type: JsonFieldType;
  description?: string | null;
  required?: boolean | null;
  objectFields?: IMidFieldBlueprint[] | null;
  arrayItemType?: JsonScalarType | "object" | null;
  arrayItemObjectFields?: IMidFieldBlueprint[] | null;
}

const ScalarFieldBlueprintSchema: z.ZodType<IScalarFieldBlueprint> = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "integer", "boolean", "null"]),
  description: z.string().nullable(),
  required: z.boolean().nullable(),
}).strict();

const MidFieldBlueprintSchema: z.ZodType<IMidFieldBlueprint> = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "integer", "boolean", "null", "array", "object"]),
  description: z.string().nullable(),
  required: z.boolean().nullable(),
  objectFields: z.array(ScalarFieldBlueprintSchema).nullable(),
  arrayItemType: z.enum(["string", "number", "integer", "boolean", "null", "object"]).nullable(),
  arrayItemObjectFields: z.array(ScalarFieldBlueprintSchema).nullable(),
}).strict();

const TopFieldBlueprintSchema: z.ZodType<ITopFieldBlueprint> = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "integer", "boolean", "null", "array", "object"]),
  description: z.string().nullable(),
  required: z.boolean().nullable(),
  objectFields: z.array(MidFieldBlueprintSchema).nullable(),
  arrayItemType: z.enum(["string", "number", "integer", "boolean", "null", "object"]).nullable(),
  arrayItemObjectFields: z.array(MidFieldBlueprintSchema).nullable(),
}).strict();

const OutputBlueprintZod = z.object({
  fields: z.array(TopFieldBlueprintSchema).min(1),
}).strict();

function _fieldTypeToSchemaType(fieldType: JsonFieldType, required: boolean): JsonFieldType | JsonFieldType[] {
  if (required || fieldType === "null") {
    return fieldType;
  }

  return [fieldType, "null"];
}

function _buildJsonSchemaForScalarField(field: IScalarFieldBlueprint): Record<string, unknown> {
  const isRequired: boolean = field.required !== false;

  const scalarSchema: Record<string, unknown> = {
    type: _fieldTypeToSchemaType(field.type, isRequired),
  };

  if (field.description) {
    scalarSchema.description = field.description;
  }

  return scalarSchema;
}

function _buildJsonSchemaForMidField(field: IMidFieldBlueprint): Record<string, unknown> {
  const isRequired: boolean = field.required !== false;

  if (field.type === "object") {
    const nestedFields: IScalarFieldBlueprint[] = Array.isArray(field.objectFields) ? field.objectFields : [];
    const properties: Record<string, unknown> = {};

    for (const nestedField of nestedFields) {
      properties[nestedField.name] = _buildJsonSchemaForScalarField(nestedField);
    }

    const objectSchema: Record<string, unknown> = {
      type: _fieldTypeToSchemaType("object", isRequired),
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };

    if (field.description) {
      objectSchema.description = field.description;
    }

    return objectSchema;
  }

  if (field.type === "array") {
    const itemType: JsonScalarType | "object" = field.arrayItemType ?? "string";
    let itemsSchema: Record<string, unknown> = { type: "string" };

    if (itemType === "object") {
      const itemFields: IScalarFieldBlueprint[] = Array.isArray(field.arrayItemObjectFields)
        ? field.arrayItemObjectFields
        : [];
      const itemProperties: Record<string, unknown> = {};

      for (const itemField of itemFields) {
        itemProperties[itemField.name] = _buildJsonSchemaForScalarField(itemField);
      }

      itemsSchema = {
        type: "object",
        properties: itemProperties,
        required: Object.keys(itemProperties),
        additionalProperties: false,
      };
    } else {
      itemsSchema = {
        type: itemType,
      };
    }

    const arraySchema: Record<string, unknown> = {
      type: _fieldTypeToSchemaType("array", isRequired),
      items: itemsSchema,
    };

    if (field.description) {
      arraySchema.description = field.description;
    }

    return arraySchema;
  }

  const scalarSchema: Record<string, unknown> = {
    type: _fieldTypeToSchemaType(field.type, isRequired),
  };

  if (field.description) {
    scalarSchema.description = field.description;
  }

  return scalarSchema;
}

function _buildJsonSchemaForTopField(field: ITopFieldBlueprint): Record<string, unknown> {
  const isRequired: boolean = field.required !== false;

  if (field.type === "object") {
    const nestedFields: IMidFieldBlueprint[] = Array.isArray(field.objectFields) ? field.objectFields : [];
    const properties: Record<string, unknown> = {};

    for (const nestedField of nestedFields) {
      properties[nestedField.name] = _buildJsonSchemaForMidField(nestedField);
    }

    const objectSchema: Record<string, unknown> = {
      type: _fieldTypeToSchemaType("object", isRequired),
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };

    if (field.description) {
      objectSchema.description = field.description;
    }

    return objectSchema;
  }

  if (field.type === "array") {
    const itemType: JsonScalarType | "object" = field.arrayItemType ?? "string";
    let itemsSchema: Record<string, unknown> = { type: "string" };

    if (itemType === "object") {
      const itemFields: IMidFieldBlueprint[] = Array.isArray(field.arrayItemObjectFields)
        ? field.arrayItemObjectFields
        : [];
      const itemProperties: Record<string, unknown> = {};

      for (const itemField of itemFields) {
        itemProperties[itemField.name] = _buildJsonSchemaForMidField(itemField);
      }

      itemsSchema = {
        type: "object",
        properties: itemProperties,
        required: Object.keys(itemProperties),
        additionalProperties: false,
      };
    } else {
      itemsSchema = {
        type: itemType,
      };
    }

    const arraySchema: Record<string, unknown> = {
      type: _fieldTypeToSchemaType("array", isRequired),
      items: itemsSchema,
    };

    if (field.description) {
      arraySchema.description = field.description;
    }

    return arraySchema;
  }

  const scalarSchema: Record<string, unknown> = {
    type: _fieldTypeToSchemaType(field.type, isRequired),
  };

  if (field.description) {
    scalarSchema.description = field.description;
  }

  return scalarSchema;
}

function _buildJsonSchemaFromBlueprint(blueprint: { fields: ITopFieldBlueprint[] }): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const field of blueprint.fields) {
    properties[field.name] = _buildJsonSchemaForTopField(field);
  }

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const createOutputSchemaToolInputSchema = z.object({
  description: z
    .string()
    .min(10)
    .describe("Natural language description of what the output should contain. Be specific about fields, types, and whether fields are required or optional."),
  context: z
    .string()
    .optional()
    .describe("Optional additional context about what the agent node will do, helps generate better field names and descriptions"),
});

export function createCreateOutputSchemaTool() {
  return tool({
    description:
      "Creates a properly formatted JSON Schema for agent node output. Use this when you need to define structured output for an agent node. " +
      "Returns a JSON Schema object that can be passed directly to add_agent_node's outputSchema parameter. " +
      "ALWAYS use this tool instead of manually creating JSON Schemas - it ensures correct syntax and best practices.",
    inputSchema: createOutputSchemaToolInputSchema,
    execute: async ({
      description,
      context,
    }: {
      description: string;
      context?: string;
    }): Promise<{
      success: boolean;
      schema: Record<string, unknown> | null;
      error?: string;
    }> => {
      const logger: LoggerService = LoggerService.getInstance();

      try {
        const aiProvider: AiProviderService = AiProviderService.getInstance();
        const model = aiProvider.getModel();

        const userPrompt: string = context
          ? `Context: ${context}\n\nCreate a field blueprint for output that: ${description}`
          : `Create a field blueprint for output that: ${description}`;

        const result = await generateObjectWithRetryAsync({
          model,
          system: SYSTEM_PROMPT,
          prompt: userPrompt,
          schema: OutputBlueprintZod,
        });

        const schema: Record<string, unknown> = _buildJsonSchemaFromBlueprint(result.object);

        logger.info("Created output schema", { schema });

        return {
          success: true,
          schema,
        };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        logger.error("Failed to create output schema", { error: errorMessage });

        return {
          success: false,
          schema: null,
          error: errorMessage,
        };
      }
    },
  });
}

// Import tool at the end to avoid circular dependency issues
import { tool } from "ai";
