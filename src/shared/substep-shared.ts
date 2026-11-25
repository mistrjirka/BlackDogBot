import type { IToolCallSummary } from "../agent/base-agent.js";

/**
 * A single sub-step produced by a delegated worker agent.
 * `parentStepNumber` is the main agent's step number that triggered the delegation.
 * `workerStepNumber` is the step number within the worker's own run.
 */
export interface ISubStep {
  parentStepNumber: number;
  workerStepNumber: number;
  toolCalls: IToolCallSummary[];
}

/**
 * Shared, process-level buffer for sub-steps produced by delegate_agent calls.
 * The delegate worker pushes sub-steps here; the main agent's combinedOnStepAsync
 * drains them before emitting the next main-agent step.
 *
 * This is safe for sequential chat processing (the main agent serialises
 * user tasks via its run queue).  Concurrent delegate calls within the same
 * run are handled by appending to the array.
 */
let _pendingSubSteps: ISubStep[] = [];

export function pushSubSteps(steps: ISubStep[]): void {
  _pendingSubSteps = [..._pendingSubSteps, ...steps];
}

export function getPendingSubSteps(): ISubStep[] {
  const steps: ISubStep[] = _pendingSubSteps;
  _pendingSubSteps = [];
  return steps;
}

export function clearPendingSubSteps(): void {
  _pendingSubSteps = [];
}