import type { ModelMessage } from "ai";

/**
 * Checks if a prerequisite tool was called in the conversation history
 * with matching required arguments.
 *
 * @param messages - The conversation history from context.messages
 * @param prerequisiteToolName - The tool that must have been called (e.g., "get_timed")
 * @param requiredArgs - Arguments that must match (e.g., { taskId: "abc" })
 * @returns true if the prerequisite was met
 */
export function hasPrerequisiteBeenMet(
  messages: ModelMessage[],
  prerequisiteToolName: string,
  requiredArgs: Record<string, unknown>,
): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }

    const content = msg.content;
    if (typeof content === "string") {
      continue;
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part === null || part.type !== "tool-call") {
          continue;
        }

        if (part.toolName !== prerequisiteToolName) {
          continue;
        }

        const input = part.input as Record<string, unknown>;
        const matches = Object.entries(requiredArgs).every(([key, value]) => {
          return input[key] === value;
        });

        if (matches) {
          return true;
        }
      }
    }
  }

  return false;
}
