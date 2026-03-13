import type { ModelMessage } from "ai";

import { FORCE_THINK_INTERVAL } from "../shared/constants.js";

//#region Types

/**
 * Return type for directives that force the think tool.
 * Removes all tools except think via `activeTools`.
 * Enforcement is done by limiting available tools only.
 */
export interface IForceThinkDirective {
  activeTools: string[];
}

//#endregion Types

//#region Public functions

/**
 * Returns whether non-think/non-done tool calls must include a non-empty
 * `reasoning` argument based on the rolling window policy.
 *
 * Reasoning is required when there were at least
 * {@link FORCE_THINK_INTERVAL} consecutive assistant tool-call steps without:
 * - a `think` tool call, and
 * - a non-think/non-done tool call containing non-empty `reasoning`.
 */
export function isReasoningRequired(messages: ModelMessage[]): boolean {
  const stepsSinceReasoningOrThink: number = _stepsSinceLastReasoningOrThink(messages);

  return stepsSinceReasoningOrThink >= FORCE_THINK_INTERVAL;
}

/**
 * Detects when the model is stuck in a loop calling the same tool with
 * identical arguments on consecutive steps. When 2 consecutive identical
 * non-think tool-call steps are detected, forces a think step to break
 * the loop.
 *
 * Only triggers if the steps are truly consecutive (no other assistant
 * messages between them). This prevents false positives when a forced
 * think breaks up an otherwise identical sequence.
 *
 * Tool call order does not matter for comparison - [crawl4ai(A), searxng(B)]
 * is considered identical to [searxng(B), crawl4ai(A)].
 *
 * Returns a `prepareStep`-compatible partial result when a loop is detected,
 * or `null` when no duplicate is found.
 */
export function getDuplicateToolCallDirective(
  stepNumber: number,
  messages: ModelMessage[],
): IForceThinkDirective | null {
  if (stepNumber < 2) {
    return null;
  }

  // If the most recent assistant step was already a think call, skip detection.
  // This means we already forced a think to break the loop — now let the model
  // proceed freely so it can make a different tool call instead of re-triggering.
  if (_lastAssistantStepIsThink(messages)) {
    return null;
  }

  // Get the last 2 non-think tool-call steps with their indices
  const steps: IToolStepWithIndex[] = _extractLastNonThinkStepsWithIndices(messages, 2);

  if (steps.length < 2) {
    return null;
  }

  const [prev, curr] = steps;

  // Check if they are truly consecutive (no other assistant messages between them)
  if (!_areAssistantMessagesConsecutive(messages, prev.index, curr.index)) {
    return null;
  }

  // Compare tool sets (order-independent)
  if (_areToolStepsIdenticalUnordered(prev.signatures, curr.signatures)) {
    return _buildForceThinkDirective();
  }

  return null;
}

//#endregion Public functions

//#region Private types

/** Compact representation of a tool call for comparison purposes. */
interface IToolCallSignature {
  toolName: string;
  argsJson: string;
}

/** Tool step with original message index for consecutiveness checking. */
interface IToolStepWithIndex {
  index: number;
  signatures: IToolCallSignature[];
}

//#endregion Private types

//#region Private functions

/**
 * Checks whether the most recent assistant message is a think tool call.
 * Used to avoid re-triggering duplicate detection right after a forced think
 * intervention — the model should get a free step to make a different choice.
 */
function _lastAssistantStepIsThink(messages: ModelMessage[]): boolean {
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

      // Found the most recent assistant message but it's not think
      return false;
    }
  }

  return false;
}

/**
 * Builds a universal force-think directive by limiting available tools
 * to only think. The `activeTools` filter works at the Vercel AI SDK
 * level (controls which tools are serialized into the API request).
 */
function _buildForceThinkDirective(): IForceThinkDirective {
  return {
    activeTools: ["think"],
  };
}

function _stepsSinceLastReasoningOrThink(messages: ModelMessage[]): number {
  let stepsCount: number = 0;

  for (let i: number = messages.length - 1; i >= 0; i--) {
    const msg: ModelMessage = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      let hasRelevantToolCalls: boolean = false;
      let hasThink: boolean = false;
      let hasReasoning: boolean = false;

      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "tool-call"
        ) {
          if (!("toolName" in part)) {
            continue;
          }

          const toolName: string = (part as { toolName: string }).toolName;

          if (toolName === "done") {
            continue;
          }

          hasRelevantToolCalls = true;

          if (toolName === "think") {
            hasThink = true;
            continue;
          }

          const toolArgs: unknown = _extractToolCallArgs(part);
          if (_hasNonEmptyReasoning(toolArgs)) {
            hasReasoning = true;
          }
        }
      }

      if (hasRelevantToolCalls) {
        if (hasThink || hasReasoning) {
          return stepsCount;
        }

        stepsCount++;
      }
    }
  }

  return stepsCount;
}

function _extractToolCallArgs(part: unknown): unknown {
  if (typeof part !== "object" || part === null) {
    return {};
  }

  const partObject: Record<string, unknown> = part as Record<string, unknown>;

  if ("args" in partObject) {
    return partObject.args;
  }

  if ("input" in partObject) {
    return partObject.input;
  }

  return {};
}

function _hasNonEmptyReasoning(toolArgs: unknown): boolean {
  if (typeof toolArgs !== "object" || toolArgs === null) {
    return false;
  }

  const argsObject: Record<string, unknown> = toolArgs as Record<string, unknown>;

  if (!("reasoning" in argsObject)) {
    return false;
  }

  const reasoningValue: unknown = argsObject.reasoning;

  return typeof reasoningValue === "string" && reasoningValue.trim().length > 0;
}

/**
 * Extracts the last N non-think tool-call steps from messages, along with
 * their original indices in the messages array.
 *
 * Returns an array of tool step objects with indices, ordered from oldest to
 * newest (i.e., index 0 = earlier step, index N-1 = most recent step).
 */
function _extractLastNonThinkStepsWithIndices(
  messages: ModelMessage[],
  n: number,
): IToolStepWithIndex[] {
  const steps: IToolStepWithIndex[] = [];

  for (let i: number = messages.length - 1; i >= 0 && steps.length < n; i--) {
    const msg: ModelMessage = messages[i];

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

    const signatures: IToolCallSignature[] = [];

    for (const part of msg.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: string }).type === "tool-call" &&
        "toolName" in part &&
        (part as { toolName: string }).toolName !== "think"
      ) {
        const toolName: string = (part as { toolName: string }).toolName;
        const args: unknown = "args" in part ? (part as { args: unknown }).args :
                               "input" in part ? (part as { input: unknown }).input : {};
        let argsJson: string;

        try {
          argsJson = JSON.stringify(args, Object.keys(args as object).sort());
        } catch {
          argsJson = String(args);
        }

        signatures.push({ toolName, argsJson });
      }
    }

    // Only count steps with at least one non-think tool call
    if (signatures.length > 0) {
      steps.push({ index: i, signatures });
    }
  }

  // Reverse so oldest is first: [previousStep, currentStep]
  return steps.reverse();
}

/**
 * Checks if two assistant message indices are consecutive in the messages array.
 * Consecutive means there are no other assistant messages between them.
 */
function _areAssistantMessagesConsecutive(
  messages: ModelMessage[],
  prevIndex: number,
  currIndex: number,
): boolean {
  for (let i: number = prevIndex + 1; i < currIndex; i++) {
    if (messages[i].role === "assistant") {
      // Found another assistant message between them
      return false;
    }
  }
  return true;
}

/**
 * Compares two tool-call steps for equality, ignoring the order of tool calls.
 * Steps are identical if they have the same set of tool calls (same names and args).
 */
function _areToolStepsIdenticalUnordered(
  stepA: IToolCallSignature[],
  stepB: IToolCallSignature[],
): boolean {
  // Check count
  if (stepA.length !== stepB.length) {
    return false;
  }

  // Sort by toolName for order-independent comparison
  const sortedA = [...stepA].sort((a, b) => a.toolName.localeCompare(b.toolName));
  const sortedB = [...stepB].sort((a, b) => a.toolName.localeCompare(b.toolName));

  // Compare each tool call
  for (let i: number = 0; i < sortedA.length; i++) {
    if (sortedA[i].toolName !== sortedB[i].toolName || sortedA[i].argsJson !== sortedB[i].argsJson) {
      return false;
    }
  }

  return true;
}

//#endregion Private functions
