import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchTimedTool } from "../../../src/tools/search-timed.tool.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

const createMockTask = (overrides: Partial<IScheduledTask> = {}): IScheduledTask => ({
  taskId: "task-1",
  name: "Morning Report",
  description: "Sends daily morning report",
  instructions: "Run the morning report script and send results to user",
  tools: ["send_message", "run_cmd"],
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
  messageDedupEnabled: true,
  ...overrides,
});

describe("searchTimedTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should exist with correct structure", () => {
    expect(searchTimedTool).toBeDefined();
    expect(typeof searchTimedTool).toBe("object");
    expect(typeof searchTimedTool.execute).toBe("function");
  });

  it("should return query in output", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "test query" });

    expect(result.query).toBe("test query");
  });

  it("should return totalMatches count", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "ZuluAlphaTask", description: "Description for alpha" }),
        createMockTask({ taskId: "task-2", name: "BetaBetaTask", description: "Description for beta" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "Zulu" });

    expect(result.totalMatches).toBe(1);
    expect(result.matches).toHaveLength(1);
  });

  it("should return matches array with correct structure", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Morning Report" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "report" });

    expect(result.matches).toBeDefined();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toHaveProperty("taskId");
    expect(result.matches[0]).toHaveProperty("name");
    expect(result.matches[0]).toHaveProperty("description");
    expect(result.matches[0]).toHaveProperty("enabled");
    expect(result.matches[0]).toHaveProperty("schedule");
    expect(result.matches[0]).toHaveProperty("score");
    expect(result.matches[0]).toHaveProperty("matchedFields");
    expect(result.matches[0]).toHaveProperty("preview");
  });

  it("should include preview with truncated instructions (~160 chars)", async () => {
    const longInstructions = "A".repeat(300);
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Test", instructions: longInstructions }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "test" });

    expect(result.matches[0].preview.instructions).toBeDefined();
    expect(result.matches[0].preview.instructions.length).toBeLessThanOrEqual(165);
    expect(result.matches[0].preview.instructions).toContain("...");
  });

  it("should use getTasksByEnabled(true) when enabledOnly=true", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([]),
      getTasksByEnabled: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Enabled Task", enabled: true }),
      ]),
    };
    const getInstanceSpy = vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    await (searchTimedTool.execute as any)({ query: "task", enabledOnly: true });

    expect(schedulerMock.getTasksByEnabled).toHaveBeenCalledWith(true);
    expect(schedulerMock.getAllTasks).not.toHaveBeenCalled();
  });

  it("should use getAllTasks() when enabledOnly=false", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    await (searchTimedTool.execute as any)({ query: "task", enabledOnly: false });

    expect(schedulerMock.getAllTasks).toHaveBeenCalled();
    expect(schedulerMock.getTasksByEnabled).not.toHaveBeenCalled();
  });

  it("should respect limit parameter", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "AlphaTask" }),
        createMockTask({ taskId: "task-2", name: "BetaTask" }),
        createMockTask({ taskId: "task-3", name: "GammaTask" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "Task", limit: 2 });

    expect(result.matches).toHaveLength(2);
  });

  it("should return score between 0 and 1 where higher is better", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Morning Report" }),
        createMockTask({ taskId: "task-2", name: "Weekly Report" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "report" });

    for (const match of result.matches) {
      expect(match.score).toBeGreaterThanOrEqual(0);
      expect(match.score).toBeLessThanOrEqual(1);
    }
  });

  it("should return matchedFields array", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "report" });

    expect(result.matches[0].matchedFields).toBeDefined();
    expect(Array.isArray(result.matches[0].matchedFields)).toBe(true);
  });

  it("should search across name, description, instructions, taskId, and tools", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ 
          taskId: "task-search", 
          name: "UniqueName", 
          description: "Common description",
          instructions: "Common instructions",
          tools: ["custom_tool"]
        }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const resultName = await (searchTimedTool.execute as any)({ query: "UniqueName" });
    expect(resultName.totalMatches).toBe(1);

    const resultDesc = await (searchTimedTool.execute as any)({ query: "Common description" });
    expect(resultDesc.totalMatches).toBe(1);

    const resultInstr = await (searchTimedTool.execute as any)({ query: "Common instructions" });
    expect(resultInstr.totalMatches).toBe(1);

    const resultId = await (searchTimedTool.execute as any)({ query: "task-search" });
    expect(resultId.totalMatches).toBe(1);

    const resultTools = await (searchTimedTool.execute as any)({ query: "custom_tool" });
    expect(resultTools.totalMatches).toBe(1);
  });

  it("should respect threshold parameter for fuzzy matching", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Morning Report" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const resultStrict = await (searchTimedTool.execute as any)({ query: "Mornng Report", threshold: 0.1 });
    const resultLenient = await (searchTimedTool.execute as any)({ query: "Mornng Report", threshold: 0.5 });

    expect(resultLenient.totalMatches).toBeGreaterThanOrEqual(resultStrict.totalMatches);
  });

  it("should return empty matches for no results", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Morning Report" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "nonexistent" });

    expect(result.totalMatches).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("should default threshold to 0.4", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Morning Report" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "report" });

    expect(result.totalMatches).toBe(1);
  });

  it("should return at most 5 results when limit is omitted", async () => {
    const manyTasks = Array.from({ length: 10 }, (_, i) =>
      createMockTask({ taskId: `task-${i}`, name: `Task ${i}` })
    );
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue(manyTasks),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "Task" });

    expect(result.matches.length).toBeLessThanOrEqual(5);
  });

  it("should reject limit > 20 in input schema", async () => {
    const { searchTimedToolInputSchema } = await import("../../../src/shared/schemas/tool-schemas.js");
    const result = searchTimedToolInputSchema.safeParse({
      query: "test",
      limit: 25,
    });
    expect(result.success).toBe(false);
  });

  it("should clamp score to [0,1] and round to 4 decimals", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        createMockTask({ taskId: "task-1", name: "Morning Report" }),
        createMockTask({ taskId: "task-2", name: "Evening Report" }),
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    };
    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

    const result = await (searchTimedTool.execute as any)({ query: "report" });

    for (const match of result.matches) {
      expect(match.score).toBeGreaterThanOrEqual(0);
      expect(match.score).toBeLessThanOrEqual(1);
      const decimalPlaces = match.score.toString().split(".")[1]?.length ?? 0;
      expect(decimalPlaces).toBeLessThanOrEqual(4);
    }
  });
});
