type ModelMessage = unknown;
import { hasPrerequisiteBeenMet } from "./tool-prerequisite.js";

/**
 * Context object passed by Vercel AI SDK to tool execute functions.
 */
export interface ToolExecuteContext {
  toolCallId: string;
  messages: ModelMessage[];
  abortSignal: AbortSignal;
}

/**
 * Represents a prerequisite that must be satisfied before a tool can execute.
 */
export interface ToolPrerequisite {
  /** The tool that must have been called */
  tool: string;
  /** Arguments that must have been passed to that tool (use TASK_ID_PLACEHOLDER for dynamic values) */
  args: Record<string, unknown>;
}

/**
 * Placeholder string that gets replaced with the actual input value at runtime.
 * Useful when the prerequisite args should match the input args (e.g., taskId).
 */
export const TASK_ID_PLACEHOLDER = "TASK_ID_PLACEHOLDER";

/**
 * Creates a tool executor that validates prerequisites before executing.
 * Compatible with Vercel AI SDK's tool() function.
 *
 * @param toolName - Name of this tool (for error messages)
 * @param prerequisites - List of prerequisites that must be met
 * @param executeFn - The original execute function that takes (input, context)
 * @returns Wrapped execute function that checks prerequisites
 */
export function createToolWithPrerequisites<TInput, TOutput>(
  toolName: string,
  prerequisites: ToolPrerequisite[],
  executeFn: (input: TInput, context: ToolExecuteContext) => Promise<TOutput>,
) {
  return async (input: TInput, context: ToolExecuteContext): Promise<TOutput> => {
    for (const prereq of prerequisites) {
      const resolvedArgs: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(prereq.args)) {
        if (value === TASK_ID_PLACEHOLDER) {
          resolvedArgs[key] = (input as Record<string, unknown>)[key];
        } else {
          resolvedArgs[key] = value;
        }
      }

      const met = hasPrerequisiteBeenMet(
        context.messages,
        prereq.tool,
        resolvedArgs,
      );

      if (!met) {
        return {
          success: false,
          error: `MISSING PREREQUISITE: You must call '${prereq.tool}' with ${JSON.stringify(resolvedArgs)} before using '${toolName}'.`,
        } as unknown as TOutput;
      }
    }

    return executeFn(input, context);
  };
}
