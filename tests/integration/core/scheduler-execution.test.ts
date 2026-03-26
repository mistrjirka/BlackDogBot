import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { createTestEnvironment, resetSingletons } from "../../utils/test-helpers.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";
import type { IConfig } from "../../../src/shared/types/config.types.js";

const env = createTestEnvironment("scheduler-execution");

function createTestTask(overrides: Partial<IScheduledTask> ={}): IScheduledTask {
  const taskId = overrides.taskId || `test-task-${Date.now()}`;
  return {
    taskId,
    name: overrides.name || "Test Task",
    description: overrides.description || "A test cron task",
    instructions: overrides.instructions || "Test instructions",
    tools: overrides.tools || ["think"],
    schedule: overrides.schedule || { type: "interval", intervalMs: 60000 },
    enabled: overrides.enabled ?? true,
    notifyUser: overrides.notifyUser ?? false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    ...overrides,
  };
}

describe("SchedulerService", () => {
  beforeAll(async () => {
    await env.setupAsync({ logLevel: "error" });

    const configDir = path.join(env.tempDir, ".blackdogbot");
    await fs.mkdir(configDir, { recursive: true });

    const config: IConfig = {
      ai: {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "test-key",
          model: "gpt-4o-mini",
        },
      },
      scheduler: {
        enabled: true,
        maxParallelCrons: 1,
        cronQueueSize: 3,
      },
      knowledge: {
        embeddingProvider: "local",
        embeddingModelPath: path.join(configDir, "models", "embedding-model"),
        embeddingDtype: "fp32",
        embeddingDevice: "cpu",
        embeddingOpenRouterModel: "",
        lancedbPath: path.join(configDir, "knowledge", "lancedb"),
      },
      skills: {
        directories: [path.join(configDir, "skills")],
      },
      logging: {
        level: "error",
      },
      services: {
        searxngUrl: "http://localhost:8080",
        crawl4aiUrl: "http://localhost:8081",
      },
    };

    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      stringifyYaml(config),
      "utf-8"
    );

    const loggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("error", path.join(env.tempDir, "logs"));

    const configService = ConfigService.getInstance();
    await configService.initializeAsync();
  }, 60000);

  afterAll(async () => {
    resetSingletons();
    await env.teardownAsync();
  });

  describe("getInstance", () => {
    it("should return a singleton instance", () => {
      const instance1 = SchedulerService.getInstance();
      const instance2 = SchedulerService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("task management", () => {
    it("should add a new cron task", async () => {
      const scheduler = SchedulerService.getInstance();

      const task = createTestTask({
        taskId: "test-add-task",
        name: "Add Task Test",
        description: "Test adding a task",
      });

      await scheduler.addTaskAsync(task);

      const tasks = scheduler.getAllTasks();
      const addedTask = tasks.find((t) => t.taskId === "test-add-task");
      expect(addedTask).toBeDefined();
      expect(addedTask?.name).toBe("Add Task Test");

      await scheduler.removeTaskAsync("test-add-task");
    }, 30000);

    it("should get task by ID", async () => {
      const scheduler = SchedulerService.getInstance();

      const task = createTestTask({
        taskId: "test-get-task",
        name: "Get Task Test",
      });

      await scheduler.addTaskAsync(task);

      const retrievedTask = await scheduler.getTaskAsync("test-get-task");
      expect(retrievedTask).toBeDefined();
      expect(retrievedTask?.name).toBe("Get Task Test");

      await scheduler.removeTaskAsync("test-get-task");
    });

    it("should return undefined for non-existent task", async () => {
      const scheduler = SchedulerService.getInstance();
      const task = await scheduler.getTaskAsync("non-existent-task-id");
      expect(task).toBeUndefined();
    });

    it("should remove an existing task", async () => {
      const scheduler = SchedulerService.getInstance();

      const task = createTestTask({
        taskId: "test-remove-task",
        name: "Remove Task Test",
      });

      await scheduler.addTaskAsync(task);

      let tasks = scheduler.getAllTasks();
      expect(tasks.find((t) => t.taskId === "test-remove-task")).toBeDefined();

      await scheduler.removeTaskAsync("test-remove-task");

      tasks = scheduler.getAllTasks();
      expect(tasks.find((t) => t.taskId === "test-remove-task")).toBeUndefined();
    });

    it("should update an existing task", async () => {
      const scheduler = SchedulerService.getInstance();

      const task = createTestTask({
        taskId: "test-update-task",
        name: "Original Name",
      });

      await scheduler.addTaskAsync(task);

      await scheduler.updateTaskAsync("test-update-task", {
        name: "Updated Name",
        description: "Updated description",
      });

      const retrievedTask = await scheduler.getTaskAsync("test-update-task");
      expect(retrievedTask?.name).toBe("Updated Name");
      expect(retrievedTask?.description).toBe("Updated description");

      await scheduler.removeTaskAsync("test-update-task");
    });

    it("should enable/disable a task", async () => {
      const scheduler = SchedulerService.getInstance();

      const task = createTestTask({
        taskId: "test-enable-task",
        name: "Enable Task Test",
        enabled: false,
      });

      await scheduler.addTaskAsync(task);

      await scheduler.setTaskEnabledAsync("test-enable-task", true);

      const enabledTask = await scheduler.getTaskAsync("test-enable-task");
      expect(enabledTask?.enabled).toBe(true);

      await scheduler.setTaskEnabledAsync("test-enable-task", false);

      const disabledTask = await scheduler.getTaskAsync("test-enable-task");
      expect(disabledTask?.enabled).toBe(false);

      await scheduler.removeTaskAsync("test-enable-task");
    });

    it("should list all tasks", async () => {
      const scheduler = SchedulerService.getInstance();

      const task1 = createTestTask({ taskId: "list-test-1", name: "List Test 1" });
      const task2 = createTestTask({ taskId: "list-test-2", name: "List Test 2" });

      await scheduler.addTaskAsync(task1);
      await scheduler.addTaskAsync(task2);

      const tasks = scheduler.getAllTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(2);

      const taskIds = tasks.map((t) => t.taskId);
      expect(taskIds).toContain("list-test-1");
      expect(taskIds).toContain("list-test-2");

      await scheduler.removeTaskAsync("list-test-1");
      await scheduler.removeTaskAsync("list-test-2");
    });

    it("should filter tasks by enabled state", async () => {
      const scheduler = SchedulerService.getInstance();

      const task1 = createTestTask({ taskId: "filter-enabled-1", name: "Enabled", enabled: true });
      const task2 = createTestTask({ taskId: "filter-enabled-2", name: "Disabled", enabled: false });

      await scheduler.addTaskAsync(task1);
      await scheduler.addTaskAsync(task2);

      const enabledTasks = scheduler.getTasksByEnabled(true);
      const disabledTasks = scheduler.getTasksByEnabled(false);

      expect(enabledTasks.some((t) => t.taskId === "filter-enabled-1")).toBe(true);
      expect(disabledTasks.some((t) => t.taskId === "filter-enabled-2")).toBe(true);

      await scheduler.removeTaskAsync("filter-enabled-1");
      await scheduler.removeTaskAsync("filter-enabled-2");
    });
  });

  describe("task execution", () => {
    it("should invoke task executor callback when task runs", async () => {
      const scheduler = SchedulerService.getInstance();

      const executionLog: string[] = [];

      scheduler.setTaskExecutor(async (task: IScheduledTask) => {
        executionLog.push(`Executed: ${task.name}`);
      });

      const task = createTestTask({
        taskId: "test-execution",
        name: "Execution Test",
        schedule: { type: "interval", intervalMs: 100 },
      });

      await scheduler.addTaskAsync(task);
      await scheduler.startAsync();

      await new Promise((resolve) => setTimeout(resolve, 300));

      await scheduler.stopAsync();
      await scheduler.removeTaskAsync("test-execution");

      expect(executionLog.length).toBeGreaterThan(0);
      expect(executionLog[0]).toContain("Executed:");
    }, 30000);

    it("should respect concurrency limit", async () => {
      const scheduler = SchedulerService.getInstance();

      const runningTasks: string[] = [];
      const maxConcurrent = { count: 0 };

      scheduler.setTaskExecutor(async (task: IScheduledTask) => {
        runningTasks.push(task.taskId);
        maxConcurrent.count = Math.max(maxConcurrent.count, runningTasks.length);
        await new Promise((resolve) => setTimeout(resolve, 50));
        runningTasks.splice(runningTasks.indexOf(task.taskId), 1);
      });

      for (let i = 0; i < 3; i++) {
        const task = createTestTask({
          taskId: `concurrent-${i}`,
          name: `Concurrent ${i}`,
          schedule: { type: "interval", intervalMs: 50 },
        });
        await scheduler.addTaskAsync(task);
      }

      await scheduler.startAsync();

      await new Promise((resolve) => setTimeout(resolve, 500));

      await scheduler.stopAsync();

      for (let i = 0; i < 3; i++) {
        await scheduler.removeTaskAsync(`concurrent-${i}`);
      }

      expect(maxConcurrent.count).toBeLessThanOrEqual(1);
    }, 30000);
  });

  describe("persistence", () => {
    it("should persist tasks across restarts", async () => {
      let scheduler = SchedulerService.getInstance();

      const task = createTestTask({
        taskId: "persist-test",
        name: "Persistence Test",
      });

      await scheduler.addTaskAsync(task);

      resetSingletons([SchedulerService]);

      scheduler = SchedulerService.getInstance();
      await scheduler.startAsync();

      const tasks = scheduler.getAllTasks();
      const persistedTask = tasks.find((t) => t.taskId === "persist-test");

      expect(persistedTask).toBeDefined();
      expect(persistedTask?.name).toBe("Persistence Test");

      await scheduler.stopAsync();
      await scheduler.removeTaskAsync("persist-test");
    }, 30000);
  });
});