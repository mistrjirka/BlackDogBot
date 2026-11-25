import type { IToolCallSummary } from "../agent/base-agent.js";

export interface ISubStep {
  workerStepNumber: number;
  toolCalls: IToolCallSummary[];
}

/** Isolated progress buffer for one parent agent. */
export class SubStepBuffer {
  private pending: ISubStep[] = [];

  public push(steps: ISubStep[]): void {
    this.pending.push(...steps);
  }

  public drain(): ISubStep[] {
    const steps = this.pending;
    this.pending = [];
    return steps;
  }
}
