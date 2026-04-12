import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTimedTool } from "../../../src/tools/get-timed.tool.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { ConfigService } from "../../../src/services/config.service.js";

describe("getTimedTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should exist with correct structure", () => {
    expect(getTimedTool).toBeDefined();
    expect(typeof getTimedTool).toBe("object");
    expect(getTimedTool.description.toLowerCase()).toContain("get");
    expect(getTimedTool.description).toContain("timed");
    expect(typeof getTimedTool.execute).toBe("function");
  });

  it("returns task with messageDedupEnabled and includes it in display", async () => {
    const task = {
      taskId: "task-a",
      name: "Task A",
      description: "desc",
      instructions: "instr",
      tools: ["send_message"],
      schedule: {
        type: "interval",
        every: { hours: 24, minutes: 0 },
        offsetFromDayStart: { hours: 8, minutes: 0 },
        timezone: "UTC",
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
      messageDedupEnabled: false,
    };

    const schedulerMock = {
      getTaskAsync: vi.fn().mockResolvedValue(task),
    } as unknown as SchedulerService;

    const configMock = {
      getConfig: vi.fn().mockReturnValue({ scheduler: { timezone: "UTC" } }),
    } as unknown as ConfigService;

    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock);
    vi.spyOn(ConfigService, "getInstance").mockReturnValue(configMock);

    const result = await (getTimedTool.execute as any)({ taskId: "task-a" }, {});

    expect(result.success).toBe(true);
    expect(result.task.messageDedupEnabled).toBe(false);
    expect(result.display).toContain("Message Dedup Enabled: false");
  });
});
