import { type Tool, type ToolCallOptions, type ToolSet } from "ai";
import { z } from "zod";

import { isReasoningRequired } from "./prepare-step.js";

//#region Constants

const _ReasoningExemptToolNames: Set<string> = new Set(["think", "done"]);

const _ReasoningDescription: string =
  "Optional concise reasoning for this tool call. " +
  "When the reasoning window is exceeded, this field becomes required for non-think tools.";

//#endregion Constants

//#region Public functions

/**
 * Wraps a ToolSet so every non-think/non-done tool:
 * - accepts an optional `reasoning` input field in schema, and
 * - enforces non-empty `reasoning` at runtime when reasoning policy requires it.
 */
export function wrapToolSetWithReasoning(tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {};

  for (const [toolName, rawTool] of Object.entries(tools)) {
    if (_ReasoningExemptToolNames.has(toolName)) {
      wrapped[toolName] = rawTool;
      continue;
    }

    wrapped[toolName] = _wrapSingleTool(toolName, rawTool as Tool<unknown, unknown>);
  }

  return wrapped;
}

//#endregion Public functions

//#region Private functions

function _wrapSingleTool(toolName: string, toolDef: Tool<unknown, unknown>): Tool<unknown, unknown> {
  const execute = toolDef.execute;
  const inputSchema = _augmentSchemaWithReasoning(toolDef.inputSchema);

  if (!execute) {
    return {
      ...toolDef,
      inputSchema,
    } as Tool<unknown, unknown>;
  }

  return {
    ...toolDef,
    inputSchema,
    execute: (input: unknown, options: ToolCallOptions): unknown => {
      const reasoningRequired: boolean = isReasoningRequired(options.messages);

      if (reasoningRequired && !_hasNonEmptyReasoning(input)) {
        throw new Error(
          `Tool \"${toolName}\" requires non-empty reasoning in this step. ` +
          `Provide a concise \"reasoning\" field or use the think tool first.`,
        );
      }

      const sanitizedInput: unknown = _stripReasoning(input);

      return execute(sanitizedInput as never, options);
    },
  } as Tool<unknown, unknown>;
}

function _augmentSchemaWithReasoning(inputSchema: unknown): unknown {
  if (!(inputSchema instanceof z.ZodObject)) {
    return inputSchema;
  }

  const schema: z.ZodObject<z.ZodRawShape> = inputSchema;
  const shape: z.ZodRawShape = schema.shape;

  if ("reasoning" in shape) {
    return inputSchema;
  }

  return schema.extend({
    reasoning: z.string()
      .optional()
      .describe(_ReasoningDescription),
  });
}

function _hasNonEmptyReasoning(input: unknown): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const inputRecord: Record<string, unknown> = input as Record<string, unknown>;

  if (!("reasoning" in inputRecord)) {
    return false;
  }

  const reasoning: unknown = inputRecord.reasoning;

  return typeof reasoning === "string" && reasoning.trim().length > 0;
}

function _stripReasoning(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }

  const inputRecord: Record<string, unknown> = input as Record<string, unknown>;

  if (!("reasoning" in inputRecord)) {
    return input;
  }

  const clone: Record<string, unknown> = { ...inputRecord };
  delete clone.reasoning;

  return clone;
}

//#endregion Private functions
