import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import type { IScheduledTask, IScheduleInterval } from "../../../src/shared/types/index.js";

const mockBuildPerTableToolsAsync = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("../../../src/utils/per-table-tools.js", () => ({
  buildPerTableToolsAsync: mockBuildPerTableToolsAsync,
}));

describe("SchedulerService offsetMinutes", () => {
  //#region Data members

  let scheduler: SchedulerService;
  let mockExecutor: ReturnType<typeof vi.fn>;
  let tempDir: string;
  let originalHome: string;
  let realConfigPath: string;

  //#endregion Data members

  //#region Constructors

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-offset-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons([SchedulerService, ConfigService]);

    const blackdogbotDir = path.join(tempDir, ".blackdogbot");
    await fs.mkdir(path.join(blackdogbotDir, "timed"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "logs"), { recursive: true });

    const logger = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);

    realConfigPath = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigPath = path.join(blackdogbotDir, "config.yaml");
    await fs.copyFile(realConfigPath, tempConfigPath);

    const configService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    scheduler = SchedulerService.getInstance();
    mockExecutor = vi.fn().mockResolvedValue(undefined);
    scheduler.setTaskExecutor(mockExecutor);
  });

  afterEach(async () => {
    await scheduler.stopAsync();
    resetSingletons([SchedulerService, ConfigService]);
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  //#endregion Constructors

  //#region Helpers

  function createIntervalTask(overrides: Partial<IScheduleInterval> & { taskId: string; name: string }): IScheduledTask {
    return {
      taskId: overrides.taskId,
      name: overrides.name,
      description: "",
      instructions: "test instructions",
      tools: ["test_tool"],
      schedule: {
        type: "interval",
        intervalMs: 1000,
        offsetMinutes: 0,
        ...overrides,
      } as IScheduleInterval,
      enabled: true,
      notifyUser: false,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageHistory: [],
      messageSummary: null,
      summaryGeneratedAt: null,
    };
  }

  //#endregion Helpers

  //#region offsetMinutes runtime behavior

  describe("offsetMinutes runtime behavior for interval tasks", () => {
    it("should delay first run by offsetMinutes * 60000 ms when offsetMinutes > 0", async () => {
      const task = createIntervalTask({
        taskId: "offset-delay-test",
        name: "Offset Delay Test",
        intervalMs: 1000,
        offsetMinutes: 1, // 1 minute delay
      });

      await scheduler.addTaskAsync(task);

      // First run should be delayed by 1 minute (60000ms)
      expect(mockExecutor).not.toHaveBeenCalled();

      // Wait 500ms - should still not have run (60s delay)
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(mockExecutor).not.toHaveBeenCalled();

      // Clean up
      await scheduler.removeTaskAsync("offset-delay-test");
    });

    it("should run at intervalMs when offsetMinutes is 0 (no initial delay)", async () => {
      const task = createIntervalTask({
        taskId: "no-offset-test",
        name: "No Offset Test",
        intervalMs: 1000, // 1 second interval
        offsetMinutes: 0,
      });

      await scheduler.addTaskAsync(task);

      // Wait 1100ms - should have run once after the interval
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(mockExecutor).toHaveBeenCalledTimes(1);

      // Clean up
      await scheduler.removeTaskAsync("no-offset-test");
    });

    it("should use setInterval after initial offset delay", async () => {
      const task = createIntervalTask({
        taskId: "interval-after-offset",
        name: "Interval After Offset",
        intervalMs: 50,
        offsetMinutes: 0, // no offset
      });

      await scheduler.addTaskAsync(task);

      // After 150ms, should have run multiple times
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mockExecutor.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Clean up
      await scheduler.removeTaskAsync("interval-after-offset");
    });
  });

  //#endregion offsetMinutes runtime behavior

  //#region Legacy migration

  describe("legacy offsetMinutes migration", () => {
    it("should normalize missing offsetMinutes to 0 and persist", async () => {
      const legacyTaskWithoutOffset = {
        taskId: "legacy-no-offset",
        name: "Legacy No Offset",
        description: "",
        instructions: "test instructions",
        tools: ["test_tool"],
        schedule: {
          type: "interval",
          intervalMs: 5000,
          // offsetMinutes intentionally missing
        },
        enabled: true,
        notifyUser: false,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageHistory: [],
        messageSummary: null,
        summaryGeneratedAt: null,
      };

      // Manually write legacy file
      const timedDir = path.join(tempDir, ".blackdogbot", "timed");
      await fs.writeFile(
        path.join(timedDir, "legacy-no-offset.json"),
        JSON.stringify(legacyTaskWithoutOffset, null, 2),
        "utf-8"
      );

      // Start scheduler - should load and migrate
      await scheduler.startAsync();

      const loadedTask = await scheduler.getTaskAsync("legacy-no-offset");
      expect(loadedTask).toBeDefined();
      expect(loadedTask!.schedule).toHaveProperty("offsetMinutes", 0);

      // Verify file was persisted with offsetMinutes: 0
      const fileContent = await fs.readFile(
        path.join(timedDir, "legacy-no-offset.json"),
        "utf-8"
      );
      const persisted = JSON.parse(fileContent);
      expect(persisted.schedule.offsetMinutes).toBe(0);
    });

    it("should not re-migrate tasks that already have offsetMinutes", async () => {
      const taskWithOffset = createIntervalTask({
        taskId: "already-has-offset",
        name: "Already Has Offset",
        intervalMs: 5000,
        offsetMinutes: 2,
      });

      await scheduler.addTaskAsync(taskWithOffset);

      const loadedTask = await scheduler.getTaskAsync("already-has-offset");
      expect(loadedTask).toBeDefined();
      expect(loadedTask!.schedule).toHaveProperty("offsetMinutes", 2);
    });
  });

  //#endregion Legacy migration
});
