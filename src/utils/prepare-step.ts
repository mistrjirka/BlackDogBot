import type { ModelMessage } from "ai";

import { FORCE_THINK_INTERVAL } from "../shared/constants.js";

//#region Public functions

/**
 * Determines whether the agent should be forced to use the think tool
 * on this step. The think tool is forced every {@link FORCE_THINK_INTERVAL}
 * steps unless the agent already called think on the previous step.
 *
 * Returns a `prepareStep`-compatible partial result when forcing is needed,
 * or `null` when no forcing is required.
 */
export function getForceThinkDirective(
  stepNumber: number,
  messages: ModelMessage[],
): { toolChoice: { type: "tool"; toolName: "think" } } | null {
  if (stepNumber <= 0 || stepNumber % FORCE_THINK_INTERVAL !== 0) {
    return null;
  }

  // Check if the last assistant message already included a think call
  const lastThought: boolean = _didLastAssistantCallThink(messages);

  if (lastThought) {
    return null;
  }

  return {
    toolChoice: { type: "tool" as const, toolName: "think" as const },
  };
}

//#endregion Public functions

//#region Private functions

function _didLastAssistantCallThink(messages: ModelMessage[]): boolean {
  for (let i: number = messages.length - 1; i >= 0; i--) {
    const msg: ModelMessage = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "tool-call" &&
          "toolName" in part &&
          (part as { toolName: string }).toolName === "think"
        ) {
          return true;
        }
      }

      // Found the last assistant message, no think call in it
      return false;
    }
  }

  return false;
}

//#endregion Private functions
