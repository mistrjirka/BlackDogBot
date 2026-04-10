import { describe, it, expect } from "vitest";
import { formatScheduledTask } from "../../../src/utils/cron-format.js";
import type { IScheduledTask, IScheduleInterval, IScheduleOnce } from "../../../src/shared/types/index.js";

describe("cron-format", () => {
  describe("formatScheduledTask", () => {
    function createTask(overrides: Partial<IScheduledTask> = {}): IScheduledTask {
      return {
        taskId: "test-id",
        name: "Test Task",
        description: "Test description",
        instructions: "Test instructions",
        tools: ["test_tool"],
        schedule: {
          type: "interval",
          every: {
            hours: 1,
            minutes: 0,
          },
          offsetFromDayStart: {
            hours: 0,
            minutes: 0,
          },
          timezone: "UTC",
        } as IScheduleInterval,
        enabled: true,
        notifyUser: false,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        messageHistory: [],
        messageSummary: null,
        summaryGeneratedAt: null,
        ...overrides,
      };
    }

    it("should format interval schedule without offset", () => {
      const task = createTask();
      const result = formatScheduledTask(task);
      expect(result).toContain("every 1h 0m (UTC)");
      expect(result).not.toContain("offset");
    });

    it("should format interval schedule with day-start offset", () => {
      const task = createTask({
        schedule: {
          type: "interval",
          every: {
            hours: 1,
            minutes: 0,
          },
          offsetFromDayStart: {
            hours: 0,
            minutes: 5,
          },
          timezone: "UTC",
        } as IScheduleInterval,
      });
      const result = formatScheduledTask(task);
      expect(result).toContain("every 1h 0m (+0h 5m from day start) (UTC)");
    });

    it("should format once schedule in human local form", () => {
      const task = createTask({
        schedule: {
          type: "once",
          runAt: "2024-06-15T10:00:00.000Z",
          offsetFromDayStart: {
            hours: 0,
            minutes: 0,
          },
          timezone: "UTC",
        } as IScheduleOnce,
      });
      const result = formatScheduledTask(task, "UTC");
      expect(result).toContain("once: Sat 2024-06-15 10:00:00 (UTC)");
    });

    it("should not show offset for once schedule with zero offsetFromDayStart", () => {
      const task = createTask({
        schedule: {
          type: "once",
          runAt: "2024-06-15T10:00:00.000Z",
          offsetFromDayStart: {
            hours: 0,
            minutes: 0,
          },
          timezone: "UTC",
        } as IScheduleOnce,
      });
      const result = formatScheduledTask(task, "UTC");
      expect(result).toContain("once: Sat 2024-06-15 10:00:00 (UTC)");
      expect(result).not.toContain("offset");
    });
  });
});
