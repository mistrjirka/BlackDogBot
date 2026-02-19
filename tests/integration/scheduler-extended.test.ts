import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SchedulerService } from "../../src/services/scheduler.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import type { IScheduledTask } from "../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-schedext-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

function resetSingletons(): void {
  (SchedulerService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

function createTask(overrides?: Partial<IScheduledTask>): IScheduledTask {
  const now: string = new Date().toISOString();

  return {
    taskId: "ext-task-001",
    name: "Extended Test Task",
    description: "A test scheduled task",
    instructions: "Do something",
    tools: ["think"],
    schedule: { type: "interval", intervalMs: 60000 },
    enabled: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

//#endregion Helpers

//#region Tests

describe("SchedulerService extended", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.stopAsync();
    resetSingletons();
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  it("should schedule and execute an interval task via the taskExecutor callback", async () => {
    vi.useFakeTimers();

    const service: SchedulerService = SchedulerService.getInstance();
    const executedTasks: string[] = [];

    service.setTaskExecutor(async (task: IScheduledTask): Promise<void> => {
      executedTasks.push(task.taskId);
    });

    await service.startAsync();

    const task: IScheduledTask = createTask({
      taskId: "interval-task",
      enabled: true,
      schedule: { type: "interval", intervalMs: 1000 },
    });

    await service.addTaskAsync(task);

    // Advance time past the interval
    await vi.advanceTimersByTimeAsync(1100);

    expect(executedTasks).toContain("interval-task");

    vi.useRealTimers();
  });

  it("should schedule and execute a once task at the specified time", async () => {
    vi.useFakeTimers();

    const service: SchedulerService = SchedulerService.getInstance();
    const executedTasks: string[] = [];

    service.setTaskExecutor(async (task: IScheduledTask): Promise<void> => {
      executedTasks.push(task.taskId);
    });

    await service.startAsync();

    const futureDate: string = new Date(Date.now() + 2000).toISOString();
    const task: IScheduledTask = createTask({
      taskId: "once-task",
      enabled: true,
      schedule: { type: "once", runAt: futureDate },
    });

    await service.addTaskAsync(task);

    // Before trigger time — not executed
    await vi.advanceTimersByTimeAsync(1000);

    expect(executedTasks).not.toContain("once-task");

    // After trigger time — executed
    await vi.advanceTimersByTimeAsync(1500);

    expect(executedTasks).toContain("once-task");

    vi.useRealTimers();
  });

  it("should skip a once task whose runAt time has already passed", async () => {
    const service: SchedulerService = SchedulerService.getInstance();
    const logger: LoggerService = LoggerService.getInstance();

    await service.startAsync();

    const pastDate: string = new Date(Date.now() - 10000).toISOString();
    const task: IScheduledTask = createTask({
      taskId: "past-task",
      enabled: true,
      schedule: { type: "once", runAt: pastDate },
    });

    await service.addTaskAsync(task);

    expect(logger.warn).toHaveBeenCalledWith(
      "Scheduled time has already passed, skipping",
      expect.objectContaining({ taskId: "past-task" }),
    );
  });

  it("should record failure status when taskExecutor throws", async () => {
    vi.useFakeTimers();

    const service: SchedulerService = SchedulerService.getInstance();

    service.setTaskExecutor(async (): Promise<void> => {
      throw new Error("Executor boom");
    });

    await service.startAsync();

    const task: IScheduledTask = createTask({
      taskId: "failing-task",
      enabled: true,
      schedule: { type: "interval", intervalMs: 500 },
    });

    await service.addTaskAsync(task);

    await vi.advanceTimersByTimeAsync(600);

    const updated: IScheduledTask | undefined = await service.getTaskAsync("failing-task");

    expect(updated).toBeDefined();
    expect(updated!.lastRunStatus).toBe("failure");
    expect(updated!.lastRunError).toBe("Executor boom");

    vi.useRealTimers();
  });

  it("should record success status after successful execution", async () => {
    vi.useFakeTimers();

    const service: SchedulerService = SchedulerService.getInstance();

    service.setTaskExecutor(async (): Promise<void> => {
      // success — no throw
    });

    await service.startAsync();

    const task: IScheduledTask = createTask({
      taskId: "success-task",
      enabled: true,
      schedule: { type: "interval", intervalMs: 500 },
    });

    await service.addTaskAsync(task);

    await vi.advanceTimersByTimeAsync(600);

    const updated: IScheduledTask | undefined = await service.getTaskAsync("success-task");

    expect(updated).toBeDefined();
    expect(updated!.lastRunStatus).toBe("success");
    expect(updated!.lastRunError).toBeNull();

    vi.useRealTimers();
  });

  it("should stop all scheduled tasks via stopAsync", async () => {
    vi.useFakeTimers();

    const service: SchedulerService = SchedulerService.getInstance();
    const executedTasks: string[] = [];

    service.setTaskExecutor(async (task: IScheduledTask): Promise<void> => {
      executedTasks.push(task.taskId);
    });

    await service.startAsync();

    const task: IScheduledTask = createTask({
      taskId: "stop-test-task",
      enabled: true,
      schedule: { type: "interval", intervalMs: 500 },
    });

    await service.addTaskAsync(task);

    await service.stopAsync();

    // Advance time — the task should not fire because it was stopped
    await vi.advanceTimersByTimeAsync(2000);

    expect(executedTasks).not.toContain("stop-test-task");

    vi.useRealTimers();
  });

  it("should schedule a cron task", async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.startAsync();

    const task: IScheduledTask = createTask({
      taskId: "cron-task",
      enabled: true,
      schedule: { type: "cron", expression: "* * * * *" },
    });

    // Should not throw when scheduling a cron task
    await expect(service.addTaskAsync(task)).resolves.toBeUndefined();

    // Task should be retrievable
    const retrieved: IScheduledTask | undefined = await service.getTaskAsync("cron-task");

    expect(retrieved).toBeDefined();
    expect(retrieved!.schedule.type).toBe("cron");
  });

  it("should not schedule disabled tasks on startup", async () => {
    const service: SchedulerService = SchedulerService.getInstance();
    const executedTasks: string[] = [];

    service.setTaskExecutor(async (task: IScheduledTask): Promise<void> => {
      executedTasks.push(task.taskId);
    });

    // Pre-persist a disabled task to disk
    const cronDir: string = path.join(tempDir, ".betterclaw", "cron");

    await fs.mkdir(cronDir, { recursive: true });

    const disabledTask: IScheduledTask = createTask({
      taskId: "disabled-on-start",
      enabled: false,
      schedule: { type: "interval", intervalMs: 100 },
    });

    await fs.writeFile(
      path.join(cronDir, "disabled-on-start.json"),
      JSON.stringify(disabledTask, null, 2),
      "utf-8",
    );

    await service.startAsync();

    // Wait briefly — task should not execute since it's disabled
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(executedTasks).not.toContain("disabled-on-start");
  });
});

//#endregion Tests
