import { IOutputSchemaBlueprint } from "../shared/schemas/output-schema-blueprint.schema.js";

function _fieldTypeToJsonSchema(fieldType: IOutputSchemaBlueprint["fields"][number]["type"]): Record<string, unknown> {
  if (fieldType === "string") {
    return { type: "string" };
  }

  if (fieldType === "number") {
    return { type: "number" };
  }

  if (fieldType === "boolean") {
    return { type: "boolean" };
  }

  if (fieldType === "stringArray") {
    return {
      type: "array",
      items: { type: "string" },
    };
  }

  // numberArray
  return {
    type: "array",
    items: { type: "number" },
  };
}

function _buildObjectProperties(fields: IOutputSchemaBlueprint["fields"]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const field of fields) {
    properties[field.name] = _fieldTypeToJsonSchema(field.type);
  }

  return properties;
}

export function convertOutputSchemaBlueprintToJsonSchema(blueprint: IOutputSchemaBlueprint): Record<string, unknown> {
  const properties: Record<string, unknown> = _buildObjectProperties(blueprint.fields);
  const requiredFieldNames: string[] = blueprint.fields.map((field) => field.name);

  if (blueprint.type === "object") {
    return {
      type: "object",
      properties,
      required: requiredFieldNames,
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties,
          required: requiredFieldNames,
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
}