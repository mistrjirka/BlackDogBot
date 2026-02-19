import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SchedulerService } from "../../src/services/scheduler.service.js";
import type { IScheduledTask } from "../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-sched-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

function createTask(overrides?: Partial<IScheduledTask>): IScheduledTask {
  const now: string = new Date().toISOString();

  return {
    taskId: "test-task-001",
    name: "Test Task",
    description: "A test scheduled task",
    instructions: "Do something",
    tools: ["think"],
    schedule: { type: "interval", intervalMs: 60000 },
    enabled: false, // disabled by default so it doesn't fire during tests
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

describe("SchedulerService", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    (SchedulerService as unknown as { _instance: null })._instance = null;
  });

  afterEach(async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.stopAsync();

    (SchedulerService as unknown as { _instance: null })._instance = null;
    await cleanupTempHomeAsync();
  });

  it("should add and retrieve a task", async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.startAsync();

    const task: IScheduledTask = createTask();

    await service.addTaskAsync(task);

    const retrieved: IScheduledTask | undefined = await service.getTaskAsync("test-task-001");

    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("Test Task");
  });

  it("should list all tasks", async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.startAsync();

    await service.addTaskAsync(createTask({ taskId: "t1", name: "Task 1" }));
    await service.addTaskAsync(createTask({ taskId: "t2", name: "Task 2" }));

    const all: IScheduledTask[] = service.getAllTasks();

    expect(all).toHaveLength(2);
  });

  it("should remove a task", async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.startAsync();

    const task: IScheduledTask = createTask();

    await service.addTaskAsync(task);
    await service.removeTaskAsync("test-task-001");

    const retrieved: IScheduledTask | undefined = await service.getTaskAsync("test-task-001");

    expect(retrieved).toBeUndefined();
  });

  it("should persist tasks to disk and reload them", async () => {
    const service1: SchedulerService = SchedulerService.getInstance();

    await service1.startAsync();
    await service1.addTaskAsync(createTask());
    await service1.stopAsync();

    // Reset singleton — simulate a restart
    (SchedulerService as unknown as { _instance: null })._instance = null;

    const service2: SchedulerService = SchedulerService.getInstance();

    await service2.startAsync();

    const retrieved: IScheduledTask | undefined = await service2.getTaskAsync("test-task-001");

    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("Test Task");
  });

  it("should filter tasks by enabled state", async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.startAsync();

    await service.addTaskAsync(createTask({ taskId: "t1", enabled: true }));
    await service.addTaskAsync(createTask({ taskId: "t2", enabled: false }));

    const enabled: IScheduledTask[] = service.getTasksByEnabled(true);
    const disabled: IScheduledTask[] = service.getTasksByEnabled(false);

    expect(enabled).toHaveLength(1);
    expect(disabled).toHaveLength(1);
    expect(enabled[0].taskId).toBe("t1");
    expect(disabled[0].taskId).toBe("t2");
  });
});

//#endregion Tests
