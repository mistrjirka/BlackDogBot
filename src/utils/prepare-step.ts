import type { ModelMessage } from "ai";

import { FORCE_THINK_INTERVAL } from "../shared/constants.js";

//#region Public functions

/**
 * Determines whether the agent should be forced to use the think tool
 * on this step. The think tool is forced if the agent hasn't used it
 * in the last {@link FORCE_THINK_INTERVAL} steps (rolling window).
 *
 * Returns a `prepareStep`-compatible partial result when forcing is needed,
 * or `null` when no forcing is required.
 */
export function getForceThinkDirective(
  stepNumber: number,
  messages: ModelMessage[],
): { toolChoice: { type: "tool"; toolName: "think" } } | null {
  if (stepNumber <= 0) {
    return null;
  }

  const stepsSinceThink: number = _stepsSinceLastThink(messages);

  if (stepsSinceThink >= FORCE_THINK_INTERVAL) {
    return {
      toolChoice: { type: "tool" as const, toolName: "think" as const },
    };
  }

  return null;
}

//#endregion Public functions

//#region Private functions

function _stepsSinceLastThink(messages: ModelMessage[]): number {
  let stepsCount: number = 0;

  for (let i: number = messages.length - 1; i >= 0; i--) {
    const msg: ModelMessage = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      let hasToolCalls = false;
      let hasThink = false;

      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "tool-call"
        ) {
          hasToolCalls = true;
          if ("toolName" in part && (part as { toolName: string }).toolName === "think") {
            hasThink = true;
          }
        }
      }

      if (hasToolCalls) {
        if (hasThink) {
          return stepsCount;
        }
        stepsCount++;
      }
    }
  }

  return stepsCount;
}

//#endregion Private functions
