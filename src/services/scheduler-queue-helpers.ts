import type Bottleneck from "bottleneck";

import type { IScheduledTask } from "../shared/types/index.js";
import { extractErrorMessage } from "../utils/error.js";
import type { LoggerService } from "./logger.service.js";

//#region Interfaces

export interface IQueuedTask {
  task: IScheduledTask;
  executeCallback: () => Promise<void>;
}

export interface ISchedulerQueueState {
  maxParallelCrons: number;
  cronQueueSize: number;
  runningTaskCount: number;
  taskQueue: IQueuedTask[];
}

export interface ISchedulerQueueDeps {
  logger: LoggerService;
  onTaskSkipped: ((task: IScheduledTask, reason: string) => Promise<void>) | null;
  taskSkippedLimiter: Bottleneck;
}

export type SchedulerDispatchOutcome = "dispatched" | "queued" | "skipped";

//#endregion Interfaces

//#region Public Functions

export function createSchedulerQueueState(input: {
  maxParallelCrons: number;
  cronQueueSize: number;
  runningTaskCount: number;
  taskQueue: IQueuedTask[];
}): ISchedulerQueueState {
  return {
    maxParallelCrons: input.maxParallelCrons,
    cronQueueSize: input.cronQueueSize,
    runningTaskCount: input.runningTaskCount,
    taskQueue: input.taskQueue,
  };
}

export function dispatchOrEnqueueTask(
  state: ISchedulerQueueState,
  deps: ISchedulerQueueDeps,
  task: IScheduledTask,
  executeCallback: () => Promise<void>,
  executeNow: (taskToRun: IScheduledTask, callback: () => Promise<void>) => void,
): SchedulerDispatchOutcome {
  if (state.runningTaskCount < state.maxParallelCrons) {
    state.runningTaskCount++;
    executeNow(task, executeCallback);
    return "dispatched";
  }

  if (state.taskQueue.length < state.cronQueueSize) {
    state.taskQueue.push({ task, executeCallback });

    deps.logger.warn("Task queued (concurrency limit reached)", {
      taskId: task.taskId,
      name: task.name,
      runningTasks: state.runningTaskCount,
      queueLength: state.taskQueue.length,
      maxParallelCrons: state.maxParallelCrons,
      cronQueueSize: state.cronQueueSize,
    });
    return "queued";
  }

  const reason: string =
    `Concurrency limit reached (${state.runningTaskCount}/${state.maxParallelCrons} running, ` +
    `${state.taskQueue.length}/${state.cronQueueSize} queued). Task skipped.`;

  deps.logger.warn("Task skipped (queue full)", {
    taskId: task.taskId,
    name: task.name,
    runningTasks: state.runningTaskCount,
    queueLength: state.taskQueue.length,
    maxParallelCrons: state.maxParallelCrons,
    cronQueueSize: state.cronQueueSize,
  });

  if (deps.onTaskSkipped) {
    deps.taskSkippedLimiter
      .schedule((): Promise<void> => deps.onTaskSkipped!(task, reason))
      .catch((error: unknown): void => {
        deps.logger.error("Failed to send task-skipped notification", {
          taskId: task.taskId,
          error: extractErrorMessage(error),
        });
      });
  }

  return "skipped";
}

export function executeWithConcurrencyTracking(
  state: ISchedulerQueueState,
  deps: ISchedulerQueueDeps,
  task: IScheduledTask,
  executeCallback: () => Promise<void>,
  onDrainQueue: () => void,
): void {
  state.runningTaskCount++;

  deps.logger.info("Task dispatched", {
    taskId: task.taskId,
    name: task.name,
    runningTasks: state.runningTaskCount,
    queueLength: state.taskQueue.length,
  });

  executeCallback().finally((): void => {
    state.runningTaskCount--;

    deps.logger.info("Task finished", {
      taskId: task.taskId,
      name: task.name,
      runningTasks: state.runningTaskCount,
      queueLength: state.taskQueue.length,
    });

    onDrainQueue();
  });
}

export function drainQueuedTasks(
  state: ISchedulerQueueState,
  deps: ISchedulerQueueDeps,
  executeNow: (taskToRun: IScheduledTask, callback: () => Promise<void>) => void,
): void {
  while (state.runningTaskCount < state.maxParallelCrons && state.taskQueue.length > 0) {
    const next: IQueuedTask = state.taskQueue.shift()!;
    state.runningTaskCount++;

    deps.logger.info("Dequeuing task", {
      taskId: next.task.taskId,
      name: next.task.name,
      remainingQueue: state.taskQueue.length,
    });

    executeNow(next.task, next.executeCallback);
  }
}

//#endregion Public Functions
