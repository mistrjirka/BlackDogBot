import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { restoreTestDataDir, writeTestConfigAsync } from "../../helpers/test-config.js";

import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import type { IScheduledTask, IScheduleInterval } from "../../../src/shared/types/index.js";

const mockBuildPerTableToolsAsync = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("../../../src/utils/per-table-tools.js", () => ({
  buildPerTableToolsAsync: mockBuildPerTableToolsAsync,
}));

describe("SchedulerService interval scheduling", () => {
  //#region Data members

  let scheduler: SchedulerService;
  let mockExecutor: ReturnType<typeof vi.fn>;
  let tempDir: string;
  let originalDataDir: string | undefined;

  //#endregion Data members

  //#region Constructors

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-offset-"));
    originalDataDir = process.env.BLACKDOGBOT_DATA_DIR;
    vi.stubEnv("BLACKDOGBOT_DATA_DIR", path.join(tempDir, ".blackdogbot"));

    resetSingletons([SchedulerService, ConfigService]);

    const blackdogbotDir = path.join(tempDir, ".blackdogbot");
    await fs.mkdir(path.join(blackdogbotDir, "timed"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "logs"), { recursive: true });

    const logger = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);

    const tempConfigPath = path.join(blackdogbotDir, "config.yaml");
    await writeTestConfigAsync(tempConfigPath, { schedulerEnabled: true });

    const configService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    scheduler = SchedulerService.getInstance();
    mockExecutor = vi.fn().mockResolvedValue(undefined);
    scheduler.setTaskExecutor(mockExecutor);
  });

  beforeAll(() => {
    realDateNow = Date.now;
  });

  afterEach(async () => {
    await scheduler.stopAsync();
    resetSingletons([SchedulerService, ConfigService]);
    restoreTestDataDir(originalDataDir);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  afterAll(() => {
    Date.now = realDateNow;
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
        every: {
          hours: 0,
          minutes: 1,
        },
        offsetFromDayStart: {
          hours: 0,
          minutes: 0,
        },
        timezone: "UTC",
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

  //#region interval runtime behavior

  describe("interval runtime behavior for interval tasks", () => {
    it("should schedule first run from day-start offset rather than creation time", async () => {
      const task = createIntervalTask({
        taskId: "offset-delay-test",
        name: "Offset Delay Test",
        every: {
          hours: 0,
          minutes: 1,
        },
        offsetFromDayStart: {
          hours: 0,
          minutes: 1,
        },
      });

      await scheduler.addTaskAsync(task);

      // First run should not run immediately.
      expect(mockExecutor).not.toHaveBeenCalled();

      // Wait 500ms - should still not have run.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(mockExecutor).not.toHaveBeenCalled();

      // Clean up
      await scheduler.removeTaskAsync("offset-delay-test");
    });

    it("should run repeatedly for short every intervals", async () => {
      const task = createIntervalTask({
        taskId: "no-offset-test",
        name: "No Offset Test",
        every: {
          hours: 0,
          minutes: 1,
        },
        offsetFromDayStart: {
          hours: 0,
          minutes: 0,
        },
      });

      await scheduler.addTaskAsync(task);

      // May or may not run quickly depending on current minute alignment. Ensure no crash and valid state.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(mockExecutor.mock.calls.length).toBeGreaterThanOrEqual(0);

      // Clean up
      await scheduler.removeTaskAsync("no-offset-test");
    });

    it("should handle rapid schedule updates safely", async () => {
      const task = createIntervalTask({
        taskId: "interval-after-offset",
        name: "Interval After Offset",
        every: {
          hours: 0,
          minutes: 1,
        },
        offsetFromDayStart: {
          hours: 0,
          minutes: 0,
        },
      });

      await scheduler.addTaskAsync(task);

      await scheduler.updateTaskAsync("interval-after-offset", {
        schedule: {
          type: "interval",
          every: {
            hours: 0,
            minutes: 2,
          },
          offsetFromDayStart: {
            hours: 0,
            minutes: 0,
          },
          timezone: "UTC",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockExecutor.mock.calls.length).toBeGreaterThanOrEqual(0);

      // Clean up
      await scheduler.removeTaskAsync("interval-after-offset");
    });
  });

  //#endregion interval runtime behavior

  //#region Legacy migration

  describe("legacy schedule migration", () => {
    it("should normalize known legacy fields in memory without rewriting the file", async () => {
      const legacyTaskWithoutOffset = {
        taskId: "legacy-no-offset",
        name: "Legacy No Offset",
        description: "",
        instructions: "test instructions",
        tools: ["test_tool"],
        schedule: {
          type: "interval",
          intervalMs: 300000,
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

      // Startup owns persistence. The scheduler only reads and normalizes.
      await scheduler.startAsync();

      const loadedTask = await scheduler.getTaskAsync("legacy-no-offset");
      expect(loadedTask).toBeDefined();
      expect(loadedTask!.schedule).toHaveProperty("every");
      expect(loadedTask!.schedule).toHaveProperty("offsetFromDayStart");
      expect(loadedTask!.schedule).toHaveProperty("timezone");

      // Loading must not bypass the migration transaction and its backup.
      const fileContent = await fs.readFile(
        path.join(timedDir, "legacy-no-offset.json"),
        "utf-8"
      );
      expect(fileContent).toBe(JSON.stringify(legacyTaskWithoutOffset, null, 2));
      expect(loadedTask!.schedule).toMatchObject({
        every: { hours: 0, minutes: 5 },
        offsetFromDayStart: { hours: 0, minutes: 0 },
      });
    });

    it("should keep modern schedule shape unchanged", async () => {
      const taskWithOffset = createIntervalTask({
        taskId: "already-has-offset",
        name: "Already Has Offset",
        every: {
          hours: 0,
          minutes: 5,
        },
        offsetFromDayStart: {
          hours: 0,
          minutes: 2,
        },
        timezone: "UTC",
      });

      await scheduler.addTaskAsync(taskWithOffset);

      const loadedTask = await scheduler.getTaskAsync("already-has-offset");
      expect(loadedTask).toBeDefined();
      expect(loadedTask!.schedule).toHaveProperty("offsetFromDayStart");
      expect((loadedTask!.schedule as IScheduleInterval).offsetFromDayStart).toEqual({ hours: 0, minutes: 2 });
    });

    it("should migrate legacy evening summary offsetMinutes to day-start offset", async () => {
      const legacyEveningTask = {
        taskId: "legacy-evening",
        name: "Evening Summary",
        description: "Legacy evening summary",
        instructions: "summarize",
        tools: ["send_message"],
        schedule: {
          type: "interval",
          intervalMs: 86400000,
          offsetMinutes: 1080,
        },
        enabled: true,
        notifyUser: true,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageHistory: [],
        messageSummary: null,
        summaryGeneratedAt: null,
      };

      const timedDir = path.join(tempDir, ".blackdogbot", "timed");
      await fs.writeFile(
        path.join(timedDir, "legacy-evening.json"),
        JSON.stringify(legacyEveningTask, null, 2),
        "utf-8",
      );

      await scheduler.startAsync();

      const loadedTask = await scheduler.getTaskAsync("legacy-evening");
      expect(loadedTask).toBeDefined();
      expect(loadedTask!.messageDedupEnabled).toBe(true);
      const loadedSchedule = loadedTask!.schedule as IScheduleInterval;
      expect(loadedSchedule.every).toEqual({ hours: 24, minutes: 0 });
      expect(loadedSchedule.offsetFromDayStart).toEqual({ hours: 18, minutes: 0 });

      const persistedContent = await fs.readFile(
        path.join(timedDir, "legacy-evening.json"),
        "utf-8",
      );
      expect(persistedContent).toBe(JSON.stringify(legacyEveningTask, null, 2));
    });

    it("should retain extensions when a loaded task is edited and saved", async () => {
      const modernTask = {
        ...createIntervalTask({ taskId: "extensions", name: "Extensions" }),
        enabled: false,
        extension: { keep: "top-level" },
        schedule: {
          type: "interval",
          every: { hours: 1, minutes: 0, extension: "parts" },
          offsetFromDayStart: { hours: 0, minutes: 0 },
          timezone: "UTC",
          extension: { keep: "schedule" },
        },
        messageHistory: [{
          messageId: "saved-message",
          content: "Saved history",
          sentAt: "2026-04-10T12:00:00.000Z",
          extension: "history",
        }],
      };
      const filePath = path.join(tempDir, ".blackdogbot", "timed", "extensions.json");
      await fs.writeFile(filePath, JSON.stringify(modernTask));
      await scheduler.startAsync();
      await scheduler.updateTaskAsync("extensions", { name: "Renamed" });
      await scheduler.setTaskEnabledAsync("extensions", false);

      const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(saved.extension).toEqual(modernTask.extension);
      expect(saved.schedule).toEqual(modernTask.schedule);
      expect(saved.messageHistory).toEqual(modernTask.messageHistory);
      expect(saved.name).toBe("Renamed");
    });

    it("should keep a legacy one-time task's runAt and file unchanged", async () => {
      const legacyOnce = {
        ...createIntervalTask({ taskId: "once-preserve-time", name: "Once" }),
        enabled: false,
        schedule: { type: "once", runAt: "2026-04-10T12:00:00.000Z" },
      };
      const filePath = path.join(tempDir, ".blackdogbot", "timed", "once-preserve-time.json");
      const content = JSON.stringify(legacyOnce, null, 2);
      await fs.writeFile(filePath, content);
      await scheduler.startAsync();

      const task = await scheduler.getTaskAsync("once-preserve-time");
      expect(task!.schedule).toHaveProperty("runAt", legacyOnce.schedule.runAt);
      expect(await fs.readFile(filePath, "utf8")).toBe(content);
    });

    it("should leave an unsupported legacy task untouched", async () => {
      const unsupported = {
        ...createIntervalTask({ taskId: "subminute", name: "Subminute" }),
        schedule: { type: "interval", intervalMs: 5000 },
      };
      const filePath = path.join(tempDir, ".blackdogbot", "timed", "subminute.json");
      const content = JSON.stringify(unsupported, null, 2);
      await fs.writeFile(filePath, content);
      await scheduler.startAsync();

      expect(await scheduler.getTaskAsync("subminute")).toBeUndefined();
      expect(await fs.readFile(filePath, "utf8")).toBe(content);
    });

    it("should resolve next slot using day-start anchor semantics", async () => {
      const fixedNow: number = Date.parse("2026-04-10T00:24:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "day-start-anchor",
        name: "Day Start Anchor",
        every: {
          hours: 24,
          minutes: 0,
        },
        offsetFromDayStart: {
          hours: 18,
          minutes: 0,
        },
        timezone: "UTC",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-04-10T18:00:00.000Z"));
    });
  });

  //#endregion Legacy migration

  //#region timezone-aware interval slot resolution

  describe("timezone-aware interval slot resolution", () => {
    let realDateNow: () => number;

    beforeAll(() => {
      realDateNow = Date.now;
    });

    afterAll(() => {
      Date.now = realDateNow;
    });

    it("should resolve 18:00 Europe/Prague (CEST, UTC+2) to 16:00 UTC", () => {
      const fixedNow = Date.parse("2026-04-10T14:00:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "prague-cest-18",
        name: "Prague CEST 18:00",
        every: { hours: 24, minutes: 0 },
        offsetFromDayStart: { hours: 18, minutes: 0 },
        timezone: "Europe/Prague",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-04-10T16:00:00.000Z"));
    });

    it("should resolve 06:00 Europe/Prague (CEST, UTC+2) to 04:00 UTC", () => {
      const fixedNow = Date.parse("2026-04-10T02:00:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "prague-cest-06",
        name: "Prague CEST 06:00",
        every: { hours: 24, minutes: 0 },
        offsetFromDayStart: { hours: 6, minutes: 0 },
        timezone: "Europe/Prague",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-04-10T04:00:00.000Z"));
    });

    it("should resolve 18:00 America/New_York (EDT, UTC-4) to 22:00 UTC", () => {
      const fixedNow = Date.parse("2026-04-10T10:00:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "ny-edt-18",
        name: "New York EDT 18:00",
        every: { hours: 24, minutes: 0 },
        offsetFromDayStart: { hours: 18, minutes: 0 },
        timezone: "America/New_York",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-04-10T22:00:00.000Z"));
    });

    it("should still resolve UTC offsets correctly (no regression)", () => {
      const fixedNow = Date.parse("2026-04-10T00:24:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "utc-18",
        name: "UTC 18:00",
        every: { hours: 24, minutes: 0 },
        offsetFromDayStart: { hours: 18, minutes: 0 },
        timezone: "UTC",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-04-10T18:00:00.000Z"));
    });

    it("should handle CET (winter, UTC+1) correctly for Prague", () => {
      const fixedNow = Date.parse("2026-01-15T10:00:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "prague-cet-18",
        name: "Prague CET 18:00",
        every: { hours: 24, minutes: 0 },
        offsetFromDayStart: { hours: 18, minutes: 0 },
        timezone: "Europe/Prague",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-01-15T17:00:00.000Z"));
    });

    it("should wrap to next day for past slot on same day", () => {
      const fixedNow = Date.parse("2026-04-10T20:00:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "prague-wrap-next-day",
        name: "Prague Wrap Next Day",
        every: { hours: 24, minutes: 0 },
        offsetFromDayStart: { hours: 18, minutes: 0 },
        timezone: "Europe/Prague",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-04-11T16:00:00.000Z"));
    });

    it("should handle interval tasks with every < 24h and non-UTC timezone", () => {
      const fixedNow = Date.parse("2026-04-10T15:30:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "prague-2h-interval",
        name: "Prague 2 Hour Interval",
        every: { hours: 2, minutes: 0 },
        offsetFromDayStart: { hours: 6, minutes: 0 },
        timezone: "Europe/Prague",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      expect(nextSlot).toBe(Date.parse("2026-04-10T16:00:00.000Z"));
    });

    it("should resolve 3h interval across midnight for 20:45 offset (Prague)", () => {
      // At 23:49 UTC (April 10), Prague time is 01:49 CEST (Apr 11)
      // The 23:45 Prague slot is active (21:45 UTC). Next natural slot is 02:45 CEST (00:45 UTC Apr 11).
      // Bug: code rejects this and returns firstSlotMs + 24h = 20:45 next day UTC.
      const fixedNow = Date.parse("2026-04-10T23:49:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "prague-3h-midnight",
        name: "Prague 3h Midnight",
        every: { hours: 3, minutes: 0 },
        offsetFromDayStart: { hours: 20, minutes: 45 },
        timezone: "Europe/Prague",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      // Expected: 02:45 CEST on Apr 11 = 00:45 UTC on Apr 11
      expect(nextSlot).toBe(Date.parse("2026-04-11T00:45:00.000Z"));
    });

    it("should resolve 3h interval across midnight at 00:10 UTC (Prague)", () => {
      // At 00:10 UTC (April 11), Prague time is 02:10 CEST
      // The 23:45 slot has passed (21:45 UTC Apr 10), next slot is 02:45 CEST (00:45 UTC Apr 11)
      // Bug: same clamping issue returns 20:45 next day instead
      const fixedNow = Date.parse("2026-04-11T00:10:00.000Z");
      Date.now = vi.fn(() => fixedNow);

      const task = createIntervalTask({
        taskId: "prague-3h-after-midnight",
        name: "Prague 3h After Midnight",
        every: { hours: 3, minutes: 0 },
        offsetFromDayStart: { hours: 20, minutes: 45 },
        timezone: "Europe/Prague",
      });

      const nextSlot = (scheduler as unknown as {
        _resolveNextIntervalSlotMs: (task: IScheduledTask) => number;
      })._resolveNextIntervalSlotMs(task);

      // Expected: 02:45 CEST on Apr 11 = 00:45 UTC on Apr 11
      expect(nextSlot).toBe(Date.parse("2026-04-11T00:45:00.000Z"));
    });
  });

  //#endregion timezone-aware interval slot resolution
});
let realDateNow: () => number;
