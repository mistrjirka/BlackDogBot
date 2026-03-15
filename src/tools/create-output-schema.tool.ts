import { z } from "zod";
import { tool } from "ai";
import { AiProviderService } from "../services/ai-provider.service.js";
import { LoggerService } from "../services/logger.service.js";
import { outputSchemaBlueprintSchema, type IOutputSchemaBlueprint } from "../shared/schemas/output-schema-blueprint.schema.js";
import { convertOutputSchemaBlueprintToJsonSchema } from "../utils/output-schema-blueprint.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";

const SYSTEM_PROMPT: string = `You design strict output blueprints for node creation.

Return ONLY a JSON object that matches this exact shape:
{
  "type": "object" | "array",
  "fields": [
    {
      "name": "fieldName",
      "type": "string" | "number" | "boolean" | "stringArray" | "numberArray"
    }
  ]
}

Rules:
1. fields must contain at least one item.
2. Use clear, non-empty field names.
3. Do not add any keys other than type and fields at top-level, and name/type in each field.
4. If output should be a list of records, use type="array".
5. If output should be a single object, use type="object".
6. Preserve requested field names whenever possible.
7. Never return JSON Schema directly.`;

const createOutputSchemaToolInputSchema = z.object({
  description: z
    .string()
    .min(10)
    .describe("Natural language description of what the output should contain. Be specific about field names and field types."),
  context: z
    .string()
    .optional()
    .describe("Optional additional context about what the node will do."),
});

export function createCreateOutputSchemaTool() {
  return tool({
    description:
      "Creates a strict outputSchema blueprint for node creation tools. " +
      "Returns both blueprint (for add_*_node outputSchema input) and schema (runtime JSON Schema preview).",
    inputSchema: createOutputSchemaToolInputSchema,
    execute: async ({
      description,
      context,
    }: {
      description: string;
      context?: string;
    }): Promise<{
      success: boolean;
      blueprint: IOutputSchemaBlueprint | null;
      schema: Record<string, unknown> | null;
      error?: string;
    }> => {
      const logger: LoggerService = LoggerService.getInstance();
      const aiProvider: AiProviderService = AiProviderService.getInstance();
      const model = aiProvider.getModel();

      try {
        const userPrompt: string = context
          ? `Context: ${context}\n\nCreate an output blueprint for: ${description}`
          : `Create an output blueprint for: ${description}`;

        const result = await generateObjectWithRetryAsync({
          model,
          system: SYSTEM_PROMPT,
          prompt: userPrompt,
          schema: outputSchemaBlueprintSchema,
          retryOptions: { callType: "schema_extraction" },
        });

        const blueprint: IOutputSchemaBlueprint = result.object;
        const schema: Record<string, unknown> = convertOutputSchemaBlueprintToJsonSchema(blueprint);

        logger.info("Created output schema blueprint", { blueprint, schema });

        return {
          success: true,
          blueprint,
          schema,
        };
      } catch (error: unknown) {
        const errorMessage = extractErrorMessage(error);

        logger.error("Failed to create output schema blueprint", { error: errorMessage });

        return {
          success: false,
          blueprint: null,
          schema: null,
          error: errorMessage,
        };
      }
    },
  });
}
