import { z } from "zod";
import { AiProviderService } from "../services/ai-provider.service.js";
import { LoggerService } from "../services/logger.service.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";

const SYSTEM_PROMPT: string = `You are a JSON Schema expert. Your ONLY job is to generate valid JSON Schemas based on user descriptions.

## Rules
1. Always use "type": "object" as the root
2. Always include a "properties" object
3. Use these types only: "string", "number", "integer", "boolean", "array", "object", "null"
4. For arrays, always include "items" describing what's in the array
5. Mark required fields in a "required" array at the root level
6. Add "description" fields for clarity - these help LLMs understand fields

## Common Patterns

### Array of objects:
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "description": "Array of items",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "Unique identifier" },
          "name": { "type": "string", "description": "Item name" }
        },
        "required": ["id", "name"]
      }
    },
    "count": { "type": "number", "description": "Total number of items" }
  },
  "required": ["items"]
}

### Simple object with fields:
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "The title" },
    "count": { "type": "number", "description": "A count" },
    "isActive": { "type": "boolean", "description": "Whether active" }
  },
  "required": ["title"]
}

### Nested objects:
{
  "type": "object",
  "properties": {
    "user": {
      "type": "object",
      "description": "User information",
      "properties": {
        "name": { "type": "string" },
        "email": { "type": "string" }
      },
      "required": ["name"]
    }
  },
  "required": ["user"]
}

## Important Notes
- Arrays MUST have an "items" property defining what's inside
- Objects MUST have a "properties" property
- Never use "$schema", "$ref", "definitions", or advanced JSON Schema features
- Keep schemas simple and flat when possible
- Always add descriptions - they help LLMs produce correct output`;

// Zod schema for the output - this enforces the structure
const OutputSchemaZod = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
});

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
          ? `Context: ${context}\n\nGenerate a JSON Schema for output that: ${description}`
          : `Generate a JSON Schema for output that: ${description}`;

        // Use generateObjectWithRetryAsync for retry logic and rate limiting
        const result = await generateObjectWithRetryAsync({
          model,
          system: SYSTEM_PROMPT,
          prompt: userPrompt,
          schema: OutputSchemaZod,
        });

        const schema: Record<string, unknown> = result.object as Record<string, unknown>;

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
