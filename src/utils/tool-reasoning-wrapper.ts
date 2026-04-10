import { type Tool, type ToolCallOptions, type ToolSet } from "ai";
import { z } from "zod";

import { LoggerService } from "../services/logger.service.js";

//#region Constants

const _ReasoningExemptToolNames: Set<string> = new Set(["think"]);

const _ReasoningDescription: string =
  "Optional concise reasoning for this tool call.";

//#endregion Constants

//#region Interfaces

export interface IToolWrapperOptions {
  /** Logger for debugging. */
  logger?: LoggerService;
}

//#endregion Interfaces

//#region Public functions

/**
 * Wraps a ToolSet so every non-think tool:
 * - accepts an optional `reasoning` input field in schema, and
 * - strips `reasoning` before passing input to the underlying tool implementation.
 */
export function wrapToolSetWithReasoning(
  tools: ToolSet,
  _options?: IToolWrapperOptions,
): ToolSet {
  const wrapped: ToolSet = {};

  for (const [toolName, rawTool] of Object.entries(tools)) {
    if (_ReasoningExemptToolNames.has(toolName)) {
      wrapped[toolName] = rawTool;
      continue;
    }

    wrapped[toolName] = _wrapSingleTool(
      toolName,
      rawTool as Tool<unknown, unknown>,
    );
  }

  return wrapped;
}

//#endregion Public functions

//#region Private functions

function _wrapSingleTool(
  _toolName: string,
  toolDef: Tool<unknown, unknown>,
): Tool<unknown, unknown> {
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
    execute: async (input: unknown, options: ToolCallOptions): Promise<unknown> => {
      const sanitizedInput: unknown = _stripReasoning(input);

      // Execute the original tool
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
