import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listTimedTool } from "../../../src/tools/list-timed.tool.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";

describe("listTimedTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should exist with correct structure", () => {
    expect(listTimedTool).toBeDefined();
    expect(typeof listTimedTool).toBe("object");
    expect(listTimedTool.description.toLowerCase()).toContain("list");
    expect(listTimedTool.description).toContain("timed");
    expect(typeof listTimedTool.execute).toBe("function");
  });

  it("returns messageDedupEnabled in task summaries", async () => {
    const schedulerMock = {
      getTasksByEnabled: vi.fn().mockReturnValue([]),
      getAllTasks: vi.fn().mockReturnValue([
        {
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
        },
      ]),
    } as unknown as SchedulerService;

    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock);

    const result = await (listTimedTool.execute as any)({ enabledOnly: false });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].messageDedupEnabled).toBe(false);
  });
});
