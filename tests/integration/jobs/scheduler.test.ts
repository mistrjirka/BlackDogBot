import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;


function createTask(overrides?: Partial<IScheduledTask>): IScheduledTask {
  const now: string = new Date().toISOString();

  return {
    taskId: "test-task-001",
    name: "Test Task",
    description: "A test scheduled task",
    instructions: "Do something",
    tools: ["think"],
    schedule: { type: "interval", intervalMs: 60000 },
    enabled: false,
    notifyUser: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: now,
    updatedAt: now,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    ...overrides,
  };
}


//#region Tests

describe("SchedulerService", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-sched-test-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");
    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);
    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);
  });

  afterEach(async () => {
    const service: SchedulerService = SchedulerService.getInstance();

    await service.stopAsync();
    resetSingletons();
    vi.restoreAllMocks();

    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  //#region CRUD

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

  //#endregion CRUD

  //#region Execution

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

    await vi.advanceTimersByTimeAsync(1000);

    expect(executedTasks).not.toContain("once-task");

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

    await expect(service.addTaskAsync(task)).resolves.toBeUndefined();

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

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(executedTasks).not.toContain("disabled-on-start");
  });

  //#endregion Execution
});

//#endregion Tests
