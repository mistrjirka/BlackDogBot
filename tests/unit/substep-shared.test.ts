import { describe, expect, it } from "vitest";
import { SubStepBuffer } from "../../src/shared/substep-shared.js";

describe("SubStepBuffer", () => {
  it("isolates independent parent agents and drains each only once", () => {
    const a = new SubStepBuffer();
    const b = new SubStepBuffer();
    const first = { workerStepNumber: 1, toolCalls: [] };
    const tenth = { workerStepNumber: 10, toolCalls: [] };
    a.push([first, tenth]);
    b.push([{ workerStepNumber: 2, toolCalls: [] }]);
    expect(a.drain()).toEqual([first, tenth]);
    expect(a.drain()).toEqual([]);
    expect(b.drain()).toEqual([{ workerStepNumber: 2, toolCalls: [] }]);
  });
});
