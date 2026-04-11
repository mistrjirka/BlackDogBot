import type { ModelMessage } from "ai";

import { FORCE_THINK_INTERVAL } from "../shared/constants.js";

//#region Constants

/**
 * How many consecutive identical non-think tool-call steps are required
 * before we treat the sequence as a likely loop.
 */
const DUPLICATE_CONSECUTIVE_STEPS: number = 3;

//#endregion Constants

//#region Public functions

/**
 * Returns whether non-think tool calls must include a non-empty
 * `reasoning` argument based on the rolling window policy.
 *
 * Reasoning is required when there were at least
 * {@link FORCE_THINK_INTERVAL} consecutive assistant tool-call steps without:
 * - a `think` tool call, and
 * - a non-think tool call containing non-empty `reasoning`.
 */
export function isReasoningRequired(messages: ModelMessage[]): boolean {
  const stepsSinceReasoningOrThink: number = _stepsSinceLastReasoningOrThink(messages);

  return stepsSinceReasoningOrThink >= FORCE_THINK_INTERVAL;
}

/**
 * Detects when the model is likely stuck in a loop calling the same tool(s)
 * with identical arguments on consecutive steps.
 *
 * Only triggers when there are at least
 * {@link DUPLICATE_CONSECUTIVE_STEPS} truly consecutive identical non-think
 * tool-call steps (no other assistant messages between them).
 *
 * Tool call order does not matter for comparison - [crawl4ai(A), searxng(B)]
 * is considered identical to [searxng(B), crawl4ai(A)].
 *
 * Returns `true` when a likely duplicate loop is detected.
 */
export function getDuplicateToolCallDirective(
  stepNumber: number,
  messages: ModelMessage[],
): boolean {
  return getDuplicateToolCallLoopInfo(stepNumber, messages).isLoopDetected;
}

/**
 * Structured information about a detected duplicate tool call loop.
 */
export interface IDuplicateToolCallLoopInfo {
  /** Whether a duplicate loop is currently detected. */
  isLoopDetected: boolean;
  /** Canonical signature of the repeated tool call(s). */
  canonicalSignature: string;
  /** Number of consecutive duplicate steps detected. */
  duplicateCount: number;
  /** Human-readable summary string for the loop. */
  summaryString: string;
}

/**
 * Returns structured information about any duplicate tool call loop detected
 * at the current step.
 *
 * @param stepNumber - The current step number (1-based).
 * @param messages - The full message history.
 * @returns Object with loop detection details including canonical signature,
 *          duplicate count, and a summary string suitable for logging/debugging.
 */
export function getDuplicateToolCallLoopInfo(
  stepNumber: number,
  messages: ModelMessage[],
): IDuplicateToolCallLoopInfo {
  if (stepNumber < DUPLICATE_CONSECUTIVE_STEPS - 1) {
    return {
      isLoopDetected: false,
      canonicalSignature: "",
      duplicateCount: 0,
      summaryString: "",
    };
  }

  if (_lastAssistantStepIsThink(messages)) {
    return {
      isLoopDetected: false,
      canonicalSignature: "",
      duplicateCount: 0,
      summaryString: "",
    };
  }

  const steps: IToolStepWithIndex[] = _extractLastNonThinkStepsWithIndices(
    messages,
    DUPLICATE_CONSECUTIVE_STEPS,
  );

  if (steps.length < DUPLICATE_CONSECUTIVE_STEPS) {
    return {
      isLoopDetected: false,
      canonicalSignature: "",
      duplicateCount: 0,
      summaryString: "",
    };
  }

  for (let i: number = 1; i < steps.length; i++) {
    if (!_areAssistantMessagesConsecutive(messages, steps[i - 1].index, steps[i].index)) {
      return {
        isLoopDetected: false,
        canonicalSignature: "",
        duplicateCount: 0,
        summaryString: "",
      };
    }
  }

  const base: IToolCallSignature[] = steps[0].signatures;
  for (let i: number = 1; i < steps.length; i++) {
    if (!_areToolStepsIdenticalUnordered(base, steps[i].signatures)) {
      return {
        isLoopDetected: false,
        canonicalSignature: "",
        duplicateCount: 0,
        summaryString: "",
      };
    }
  }

  const canonicalSignature: string = _canonicalSignatureFromSignatures(base);
  const duplicateCount: number = _countConsecutiveDuplicateSteps(messages, base);
  const summaryString: string = _formatLoopSummary(base, duplicateCount);

  return {
    isLoopDetected: true,
    canonicalSignature,
    duplicateCount,
    summaryString,
  };
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

        const argsJson: string = _toCanonicalJson(args);

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

  // Sort by full signature for order-independent comparison.
  const signatureKey = (signature: IToolCallSignature): string =>
    `${signature.toolName}\u0000${signature.argsJson}`;
  const sortedA = [...stepA].sort((a, b) => signatureKey(a).localeCompare(signatureKey(b)));
  const sortedB = [...stepB].sort((a, b) => signatureKey(a).localeCompare(signatureKey(b)));

  // Compare each tool call
  for (let i: number = 0; i < sortedA.length; i++) {
    if (sortedA[i].toolName !== sortedB[i].toolName || sortedA[i].argsJson !== sortedB[i].argsJson) {
      return false;
    }
  }

  return true;
}

function _toCanonicalJson(value: unknown): string {
  try {
    return JSON.stringify(_canonicalizeValue(value));
  } catch {
    return String(value);
  }
}

function _canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown): unknown => _canonicalizeValue(item));
  }

  if (typeof value === "object" && value !== null) {
    const obj: Record<string, unknown> = value as Record<string, unknown>;
    const keys: string[] = Object.keys(obj).sort();
    const canonical: Record<string, unknown> = {};

    for (const key of keys) {
      canonical[key] = _canonicalizeValue(obj[key]);
    }

    return canonical;
  }

  return value;
}

function _canonicalSignatureFromSignatures(signatures: IToolCallSignature[]): string {
  const sorted: IToolCallSignature[] = [...signatures].sort((a, b) => {
    const keyA: string = `${a.toolName}\u0000${a.argsJson}`;
    const keyB: string = `${b.toolName}\u0000${b.argsJson}`;
    return keyA.localeCompare(keyB);
  });

  return sorted
    .map((s: IToolCallSignature): string => `${s.toolName}(${s.argsJson})`)
    .join("|");
}

function _formatLoopSummary(signatures: IToolCallSignature[], count: number): string {
  const details: string = signatures
    .map((s: IToolCallSignature): string => `${s.toolName}(${s.argsJson})`)
    .join("; ");

  return `${count}x(${details})`;
}

function _countConsecutiveDuplicateSteps(
  messages: ModelMessage[],
  signatureBase: IToolCallSignature[],
): number {
  let count: number = 0;
  const reversedMessages: ModelMessage[] = [...messages].reverse();

  for (const message of reversedMessages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const signatures: IToolCallSignature[] = [];
    let hasAssistantToolCall: boolean = false;

    for (const part of message.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: string }).type === "tool-call"
      ) {
        hasAssistantToolCall = true;

        if (!("toolName" in part)) {
          continue;
        }

        const toolName: string = (part as { toolName: string }).toolName;
        if (toolName === "think") {
          return count;
        }

        const args: unknown =
          "args" in part ? (part as { args: unknown }).args :
          "input" in part ? (part as { input: unknown }).input :
          {};

        signatures.push({ toolName, argsJson: _toCanonicalJson(args) });
      }
    }

    // Assistant step with no tool call (e.g. text) breaks the duplicate streak.
    if (!hasAssistantToolCall) {
      return count;
    }

    // Assistant step that only contained think should not be counted and breaks streak.
    if (signatures.length === 0) {
      return count;
    }

    if (!_areToolStepsIdenticalUnordered(signatureBase, signatures)) {
      return count;
    }

    count++;
  }

  return count;
}

//#endregion Private functions
