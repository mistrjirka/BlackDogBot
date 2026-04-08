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
          intervalMs: 3600000,
          offsetMinutes: 0,
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
      expect(result).toContain("interval: 3600000ms");
      expect(result).not.toContain("offset");
    });

    it("should format interval schedule with offsetMinutes > 0", () => {
      const task = createTask({
        schedule: {
          type: "interval",
          intervalMs: 3600000,
          offsetMinutes: 5,
        } as IScheduleInterval,
      });
      const result = formatScheduledTask(task);
      expect(result).toContain("interval: 3600000ms (+5m offset)");
    });

    it("should format once schedule", () => {
      const task = createTask({
        schedule: {
          type: "once",
          runAt: "2024-06-15T10:00:00.000Z",
          offsetMinutes: 0,
        } as IScheduleOnce,
      });
      const result = formatScheduledTask(task);
      expect(result).toContain("once: 2024-06-15T10:00:00.000Z");
    });

    it("should not show offset for once schedule with offsetMinutes = 0", () => {
      const task = createTask({
        schedule: {
          type: "once",
          runAt: "2024-06-15T10:00:00.000Z",
          offsetMinutes: 0,
        } as IScheduleOnce,
      });
      const result = formatScheduledTask(task);
      expect(result).toContain("once: 2024-06-15T10:00:00.000Z");
      expect(result).not.toContain("offset");
    });
  });
});
