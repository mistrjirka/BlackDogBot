import { describe, expect, it, vi } from "vitest";
import Bottleneck from "bottleneck";

import {
  createSchedulerQueueState,
  dispatchOrEnqueueTask,
  type ISchedulerQueueDeps,
} from "../../../src/services/scheduler-queue-helpers.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

function createTask(taskId: string): IScheduledTask {
  const nowIso: string = new Date().toISOString();
  return {
    taskId,
    name: taskId,
    description: "test task",
    instructions: "test instructions",
    tools: ["think"],
    schedule: {
      type: "interval",
      intervalMs: 50,
    },
    enabled: true,
    notifyUser: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
  };
}

describe("scheduler queue helpers", () => {
  it("should not enqueue duplicate pending entries for the same task", () => {
    const state = createSchedulerQueueState({
      maxParallelCrons: 1,
      cronQueueSize: 3,
      runningTaskCount: 1,
      taskQueue: [],
    });

    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as ISchedulerQueueDeps["logger"];

    const deps: ISchedulerQueueDeps = {
      logger,
      onTaskSkipped: vi.fn(async () => {}),
      taskSkippedLimiter: new Bottleneck({ minTime: 1 }),
    };

    const task = createTask("concurrent-0");
    const executeNow = vi.fn();
    const executeCallback = async (): Promise<void> => {};

    dispatchOrEnqueueTask(state, deps, task, executeCallback, executeNow);
    dispatchOrEnqueueTask(state, deps, task, executeCallback, executeNow);

    expect(state.taskQueue.length).toBe(1);
  });
});
