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

  describe("search behavior", () => {
    it("should return empty results when no tasks exist", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "anything" });

      expect(result.totalMatches).toBe(0);
      expect(result.matches).toEqual([]);
    });

    it("should return empty results when query matches nothing", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "xyznonexistent123" });

      expect(result.totalMatches).toBe(0);
      expect(result.matches).toEqual([]);
    });

    it("should find tasks by name with exact match", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
          createMockTask({ taskId: "task-2", name: "Evening Summary", description: "Nightly summaries" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "Morning Report" });

      expect(result.totalMatches).toBeGreaterThan(0);
      const morningMatch = result.matches.find((m: { name: string }) => m.name === "Morning Report");
      expect(morningMatch).toBeDefined();
      expect(morningMatch!.score).toBeGreaterThan(0.5);
    });

    it("should find tasks by description", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Task1", description: "Sends weekly analytics" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "weekly analytics" });

      expect(result.totalMatches).toBe(1);
      expect(result.matches[0].matchedFields).toContain("description");
    });

    it("should find tasks by instructions", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Task1", description: "Generic", instructions: "Run backup script nightly" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "backup script" });

      expect(result.totalMatches).toBe(1);
      expect(result.matches[0].matchedFields).toContain("instructions");
    });

    it("should find tasks by taskId", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "unique-task-id-123", name: "Task1", description: "Generic" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "unique-task-id-123" });

      expect(result.totalMatches).toBe(1);
      expect(result.matches[0].matchedFields).toContain("taskId");
    });

    it("should find tasks by tool name", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Task1", description: "Generic", tools: ["custom_backup_tool"] }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "custom_backup_tool" });

      expect(result.totalMatches).toBe(1);
      expect(result.matches[0].matchedFields).toContain("tools");
    });

    it("should return multiple matches sorted by relevance", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Report Generator", description: "Generates reports" }),
          createMockTask({ taskId: "task-2", name: "Daily Report", description: "Daily summaries" }),
          createMockTask({ taskId: "task-3", name: "Weekly Report", description: "Weekly summaries" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "report" });

      expect(result.totalMatches).toBe(3);
      expect(result.matches.length).toBeLessThanOrEqual(5);
      expect(result.matches.every((m: { score: number }) => m.score >= 0 && m.score <= 1)).toBe(true);
    });

    it("should perform fuzzy matching for partial queries", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "mornng rpert" });

      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it("should respect threshold parameter for fuzzy matching strictness", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const strictResult = await (searchTimedTool.execute as any)({ query: "mornng rpert", threshold: 0.1 });
      const lenientResult = await (searchTimedTool.execute as any)({ query: "mornng rpert", threshold: 0.6 });

      expect(lenientResult.totalMatches).toBeGreaterThanOrEqual(strictResult.totalMatches);
    });
  });

  describe("filtering", () => {
    it("should filter to enabled tasks only when enabledOnly=true", async () => {
      const enabledTask = createMockTask({ taskId: "task-1", name: "Enabled Task", enabled: true });
      const disabledTask = createMockTask({ taskId: "task-2", name: "Disabled Task", enabled: false });

      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([enabledTask, disabledTask]),
        getTasksByEnabled: vi.fn().mockReturnValue([enabledTask]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      await (searchTimedTool.execute as any)({ query: "task", enabledOnly: true });

      expect(schedulerMock.getTasksByEnabled).toHaveBeenCalledWith(true);
      expect(schedulerMock.getAllTasks).not.toHaveBeenCalled();
    });

    it("should include all tasks when enabledOnly=false", async () => {
      const enabledTask = createMockTask({ taskId: "task-1", name: "Enabled Task", enabled: true });
      const disabledTask = createMockTask({ taskId: "task-2", name: "Disabled Task", enabled: false });

      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([enabledTask, disabledTask]),
        getTasksByEnabled: vi.fn().mockReturnValue([enabledTask]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      await (searchTimedTool.execute as any)({ query: "task", enabledOnly: false });

      expect(schedulerMock.getAllTasks).toHaveBeenCalled();
      expect(schedulerMock.getTasksByEnabled).not.toHaveBeenCalled();
    });

    it("should return both enabled and disabled tasks when searching all", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Enabled Task", enabled: true }),
          createMockTask({ taskId: "task-2", name: "Disabled Task", enabled: false }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "task", enabledOnly: false });

      expect(result.totalMatches).toBe(2);
    });
  });

  describe("limiting", () => {
    it("should limit results to specified limit", async () => {
      const manyTasks = Array.from({ length: 10 }, (_, i) =>
        createMockTask({ taskId: `task-${i}`, name: `Report Task ${i}`, description: "A report task" })
      );
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue(manyTasks),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "report", limit: 3 });

      expect(result.matches).toHaveLength(3);
      expect(result.totalMatches).toBeGreaterThan(3);
    });

    it("should default to 5 results when limit is omitted", async () => {
      const manyTasks = Array.from({ length: 10 }, (_, i) =>
        createMockTask({ taskId: `task-${i}`, name: `Report Task ${i}`, description: "A report task" })
      );
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue(manyTasks),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "report" });

      expect(result.matches.length).toBeLessThanOrEqual(5);
    });

    it("should reject limit greater than 20 via input schema", async () => {
      const { searchTimedToolInputSchema } = await import("../../../src/shared/schemas/tool-schemas.js");
      const result = searchTimedToolInputSchema.safeParse({
        query: "test",
        limit: 25,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("output format", () => {
    it("should return match with all required fields", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "report" });

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match).toHaveProperty("taskId");
      expect(match).toHaveProperty("name");
      expect(match).toHaveProperty("description");
      expect(match).toHaveProperty("enabled");
      expect(match).toHaveProperty("schedule");
      expect(match).toHaveProperty("score");
      expect(match).toHaveProperty("matchedFields");
      expect(match).toHaveProperty("preview");
    });

    it("should include matchedFields array indicating which fields matched", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "Morning" });

      expect(result.matches[0].matchedFields).toBeDefined();
      expect(Array.isArray(result.matches[0].matchedFields)).toBe(true);
      expect(result.matches[0].matchedFields).toContain("name");
    });

    it("should truncate instructions preview to ~160 characters", async () => {
      const longInstructions = "A".repeat(300);
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Test", instructions: longInstructions }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "test" });

      expect(result.matches[0].preview.instructions.length).toBeLessThanOrEqual(163);
      expect(result.matches[0].preview.instructions).toContain("...");
    });

    it("should not truncate short instructions", async () => {
      const shortInstructions = "Short instruction";
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Test", instructions: shortInstructions }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "test" });

      expect(result.matches[0].preview.instructions).toBe(shortInstructions);
      expect(result.matches[0].preview.instructions).not.toContain("...");
    });

    it("should return score normalized to [0, 1] range", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
          createMockTask({ taskId: "task-2", name: "Evening Report", description: "Nightly reports" }),
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

    it("should round score to 4 decimal places", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "report" });

      for (const match of result.matches) {
        const decimalPart = match.score.toString().split(".")[1];
        if (decimalPart) {
          expect(decimalPart.length).toBeLessThanOrEqual(4);
        }
      }
    });

    it("should echo back the query in the result", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "my search query" });

      expect(result.query).toBe("my search query");
    });
  });

  describe("edge cases", () => {
    it("should handle empty query string by returning all tasks", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "" });

      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.query).toBe("");
    });

    it("should handle special characters in query", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Report #123", description: "Task with @mention and $var" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "#123" });

      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it("should handle unicode characters in query", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "日本語タスク", description: "日本語の説明" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "日本語" });

      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it("should handle case-insensitive search", async () => {
      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([
          createMockTask({ taskId: "task-1", name: "Morning Report", description: "Daily reports" }),
        ]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "MORNING REPORT" });

      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it("should handle tasks with missing optional fields", async () => {
      const minimalTask: IScheduledTask = {
        taskId: "minimal-task",
        name: "Minimal",
        description: "",
        instructions: "",
        tools: [],
        schedule: {
          type: "interval",
          every: { hours: 1, minutes: 0 },
          offsetFromDayStart: { hours: 0, minutes: 0 },
          timezone: "UTC",
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
        messageDedupEnabled: false,
      };

      const schedulerMock = {
        getAllTasks: vi.fn().mockReturnValue([minimalTask]),
        getTasksByEnabled: vi.fn().mockReturnValue([]),
      };
      vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock as unknown as SchedulerService);

      const result = await (searchTimedTool.execute as any)({ query: "minimal" });

      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.matches[0].preview.instructions).toBe("");
    });
  });
});
