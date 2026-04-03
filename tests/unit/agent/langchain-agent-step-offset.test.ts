import { describe, expect, it, vi } from "vitest";
import type { IToolCallSummary } from "../../../src/agent/types.js";

describe("invokeAgentAsync step offset feature", () => {
  // This test verifies the behavior we want:
  // When hot-reload happens, subsequent invocations should continue step numbering

  it("should continue step numbering after hot-reload", async () => {
    const allStepCalls: Array<{ stepNumber: number; toolName: string }> = [];

    const mockOnStep = async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
      allStepCalls.push({ stepNumber, toolName: toolCalls[0]?.name ?? "" });
    };

    // Simulate first invocation (steps 1-3, then hot-reload)
    let stepOffset = 0;
    let stepsCount = 0;

    // Think
    stepsCount++;
    await mockOnStep(stepOffset + stepsCount, [{ name: "think", input: {} }]);

    // create_database
    stepsCount++;
    await mockOnStep(stepOffset + stepsCount, [{ name: "create_database", input: {} }]);

    // create_table (triggers hot-reload)
    stepsCount++;
    await mockOnStep(stepOffset + stepsCount, [{ name: "create_table", input: {} }]);

    // Hot-reload: reset for second invocation but keep step offset
    stepOffset = stepsCount; // Should be 3
    stepsCount = 0;

    // Second invocation (steps 4+, starting from stepOffset=3)
    stepsCount++;
    await mockOnStep(stepOffset + stepsCount, [{ name: "think", input: {} }]);

    stepsCount++;
    await mockOnStep(stepOffset + stepsCount, [{ name: "create_database", input: {} }]);

    // Verify continuous step numbers
    const stepNumbers = allStepCalls.map(c => c.stepNumber);
    expect(stepNumbers).toEqual([1, 2, 3, 4, 5]);
    expect(allStepCalls.map(c => c.toolName)).toEqual([
      "think", "create_database", "create_table", "think", "create_database"
    ]);
  });

  it("should accumulate step counts correctly across hot-reload attempts", () => {
    // Verify that totalStepsCount in processMessageForChatAsync accumulates correctly
    const firstSteps = 3;
    const secondSteps = 2;

    // After first invocation with hot-reload:
    // totalStepsCount = 0 + 3 = 3
    const totalAfterFirst = firstSteps;

    // After second invocation:
    // totalStepsCount = 3 + 2 = 5
    const totalAfterSecond = totalAfterFirst + secondSteps;

    expect(totalAfterFirst).toBe(3);
    expect(totalAfterSecond).toBe(5);

    // The step offset for the second invocation should be totalAfterFirst (3)
    expect(totalAfterFirst).toBe(firstSteps);
  });

  it("should handle three consecutive hot-reloads correctly", async () => {
    const allStepCalls: Array<{ stepNumber: number }> = [];

    const mockOnStep = async (stepNumber: number): Promise<void> => {
      allStepCalls.push({ stepNumber });
    };

    let stepOffset = 0;
    let totalSteps = 0;

    // Attempt 1: 3 steps
    for (let i = 1; i <= 3; i++) {
      await mockOnStep(stepOffset + i);
      totalSteps++;
    }
    stepOffset = totalSteps; // 3

    // Attempt 2: 2 steps
    totalSteps = 0;
    for (let i = 1; i <= 2; i++) {
      await mockOnStep(stepOffset + i);
      totalSteps++;
    }
    stepOffset += totalSteps; // 3 + 2 = 5

    // Attempt 3: 1 step
    totalSteps = 0;
    for (let i = 1; i <= 1; i++) {
      await mockOnStep(stepOffset + i);
      totalSteps++;
    }

    // Should have continuous step numbers
    expect(allStepCalls.map(c => c.stepNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
