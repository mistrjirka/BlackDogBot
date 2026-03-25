import { beforeEach, describe, expect, it, vi } from "vitest";

import { listCronsTool } from "../../../src/tools/list-crons.tool.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

vi.mock("../../../src/services/scheduler.service.js", () => ({
  SchedulerService: {
    getInstance: vi.fn(),
  },
}));

function createScheduledTask(overrides: Partial<IScheduledTask> = {}): IScheduledTask {
  return {
    taskId: "task-1",
    name: "test_cron",
    description: "Test cron task",
    instructions: "Do test work",
    tools: ["read_from_database", "send_message"],
    schedule: {
      type: "cron",
      expression: "0 * * * *",
    },
    enabled: true,
    notifyUser: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: "2026-03-23T00:00:00.000Z",
    updatedAt: "2026-03-23T00:00:00.000Z",
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    ...overrides,
  };
}

describe("list_crons tool", () => {
  let mockScheduler: {
    getAllTasks: ReturnType<typeof vi.fn>;
    getTasksByEnabled: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockScheduler = {
      getAllTasks: vi.fn(),
      getTasksByEnabled: vi.fn(),
    };

    vi.mocked(SchedulerService.getInstance).mockReturnValue(
      mockScheduler as unknown as SchedulerService,
    );
  });

  it("returns tools for each listed cron task", async () => {
    mockScheduler.getAllTasks.mockReturnValue([
      createScheduledTask({
        taskId: "cron-1",
        tools: ["fetch_rss", "write_table_articles", "send_message"],
      }),
    ]);

    const result = await (listCronsTool as any).invoke({ enabledOnly: false });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe("cron-1");
    expect(result.tasks[0].tools).toEqual(["fetch_rss", "write_table_articles", "send_message"]);
    expect(mockScheduler.getAllTasks).toHaveBeenCalledTimes(1);
    expect(mockScheduler.getTasksByEnabled).not.toHaveBeenCalled();
  });

  it("uses enabled-only path and still includes tools", async () => {
    mockScheduler.getTasksByEnabled.mockReturnValue([
      createScheduledTask({
        taskId: "cron-enabled",
        tools: ["read_from_database", "send_message"],
      }),
    ]);

    const result = await (listCronsTool as any).invoke({ enabledOnly: true });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe("cron-enabled");
    expect(result.tasks[0].tools).toEqual(["read_from_database", "send_message"]);
    expect(mockScheduler.getTasksByEnabled).toHaveBeenCalledWith(true);
    expect(mockScheduler.getAllTasks).not.toHaveBeenCalled();
  });
});
