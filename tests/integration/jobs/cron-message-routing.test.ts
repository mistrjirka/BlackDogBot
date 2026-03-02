import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCronTaskAsync, type ICronTaskExecutorDeps } from "../../../src/executors/cron-task-executor.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

/**
 * Deterministic tests for cron task message routing.
 * No LLM calls — all agent behavior is mocked.
 *
 * Tests verify that:
 * - send_message tool calls ALWAYS broadcast to notification channels (regardless of notifyUser)
 * - Agent's final text output is forwarded to notification channels ONLY when notifyUser=true
 * - Logs and UI broadcasts always happen regardless of notifyUser
 */

function createMockTask(overrides: Partial<IScheduledTask> = {}): IScheduledTask {
  return {
    taskId: "test-task-id",
    name: "test-task",
    description: "A test task",
    instructions: "Do something",
    tools: ["send_message"],
    schedule: { type: "cron", expression: "0 * * * *" },
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
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<ICronTaskExecutorDeps> = {}): ICronTaskExecutorDeps & {
  notificationMessages: string[];
  broadcastMessages: Array<{ taskName: string; message: string }>;
  logMessages: string[];
} {
  const notificationMessages: string[] = [];
  const broadcastMessages: Array<{ taskName: string; message: string }> = [];
  const logMessages: string[] = [];

  return {
    notificationMessages,
    broadcastMessages,
    logMessages,
    broadcastToNotificationChannelsAsync: vi.fn(async (message: string): Promise<void> => {
      notificationMessages.push(message);
    }),
    broadcastCronMessage: vi.fn((taskName: string, message: string): void => {
      broadcastMessages.push({ taskName, message });
    }),
    logInfo: vi.fn((message: string, _meta?: Record<string, unknown>): void => {
      logMessages.push(message);
    }),
    executeTaskAsync: vi.fn(async (_task, _sender, _taskIdProvider) => ({ text: "", stepsCount: 1 })),
    openJobLogAsync: vi.fn(async () => {}),
    closeJobLog: vi.fn(() => {}),
    getJobLogPath: vi.fn((name: string, ts: string) => `/tmp/test-logs/${name}-${ts}.log`),
    ...overrides,
  };
}

describe("Cron Task Message Routing", () => {
  describe("send_message tool (explicit agent calls)", () => {
    it("should ALWAYS broadcast to notification channels when agent calls send_message, even with notifyUser=false", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: false });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async (_task, sender, _taskIdProvider) => {
          await sender("Hello from send_message tool");
          return { text: "", stepsCount: 1 };
        }),
      });

      await executeCronTaskAsync(task, deps);

      expect(deps.notificationMessages).toContain("Hello from send_message tool");
      expect(deps.broadcastMessages).toContainEqual({
        taskName: "test-task",
        message: "Hello from send_message tool",
      });
    });

    it("should ALWAYS broadcast to notification channels when agent calls send_message with notifyUser=true", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: true });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async (_task, sender, _taskIdProvider) => {
          await sender("Hello from send_message tool");
          return { text: "", stepsCount: 1 };
        }),
      });

      await executeCronTaskAsync(task, deps);

      expect(deps.notificationMessages).toContain("Hello from send_message tool");
    });

    it("should broadcast multiple messages to notification channels when agent calls send_message multiple times", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: false });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async (_task, sender, _taskIdProvider) => {
          await sender("Progress: step 1 complete");
          await sender("Progress: step 2 complete");
          await sender("Final results: everything passed");
          return { text: "", stepsCount: 3 };
        }),
      });

      await executeCronTaskAsync(task, deps);

      expect(deps.notificationMessages).toEqual([
        "Progress: step 1 complete",
        "Progress: step 2 complete",
        "Final results: everything passed",
      ]);
    });
  });

  describe("agent final text output (automatic forwarding)", () => {
    it("should forward final text to notification channels when notifyUser=true", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: true });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async () => ({
          text: "Task completed: fetched 5 articles",
          stepsCount: 2,
        })),
      });

      await executeCronTaskAsync(task, deps);

      expect(deps.notificationMessages).toContain("Task completed: fetched 5 articles");
      expect(deps.broadcastMessages).toContainEqual({
        taskName: "test-task",
        message: "Task completed: fetched 5 articles",
      });
    });

    it("should NOT forward final text to notification channels when notifyUser=false", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: false });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async () => ({
          text: "Task completed: fetched 5 articles",
          stepsCount: 2,
        })),
      });

      await executeCronTaskAsync(task, deps);

      // Final text should NOT go to notification channels
      expect(deps.notificationMessages).toEqual([]);

      // But it should still be broadcast to UI and logged
      expect(deps.broadcastMessages).toContainEqual({
        taskName: "test-task",
        message: "Task completed: fetched 5 articles",
      });
      expect(deps.logMessages.some((m) => m.includes("Task completed: fetched 5 articles"))).toBe(true);
    });

    it("should not forward anything when agent returns empty text", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: true });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async () => ({ text: "", stepsCount: 1 })),
      });

      await executeCronTaskAsync(task, deps);

      expect(deps.notificationMessages).toEqual([]);
      expect(deps.broadcastMessages).toEqual([]);
    });
  });

  describe("combined: send_message calls + final text", () => {
    it("should send tool messages AND final text to notification channels when notifyUser=true", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: true });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async (_task, sender, _taskIdProvider) => {
          await sender("Searching for news...");
          await sender("Found 5 articles");
          return { text: "Summary: processed 5 articles and stored results", stepsCount: 3 };
        }),
      });

      await executeCronTaskAsync(task, deps);

      // All three messages should reach notification channels
      expect(deps.notificationMessages).toEqual([
        "Searching for news...",
        "Found 5 articles",
        "Summary: processed 5 articles and stored results",
      ]);
    });

    it("should send ONLY tool messages to notification channels when notifyUser=false, NOT the final text", async () => {
      const task: IScheduledTask = createMockTask({ notifyUser: false });
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async (_task, sender, _taskIdProvider) => {
          await sender("Searching for news...");
          await sender("Found 5 articles");
          return { text: "Summary: processed 5 articles and stored results", stepsCount: 3 };
        }),
      });

      await executeCronTaskAsync(task, deps);

      // Only send_message calls should reach notification channels — NOT the final summary
      expect(deps.notificationMessages).toEqual([
        "Searching for news...",
        "Found 5 articles",
      ]);

      // But the final text should still be broadcast to UI
      expect(deps.broadcastMessages).toContainEqual({
        taskName: "test-task",
        message: "Summary: processed 5 articles and stored results",
      });
    });
  });

  describe("job log lifecycle", () => {
    it("should open and close job logs even when execution fails", async () => {
      const task: IScheduledTask = createMockTask();
      const deps = createMockDeps({
        executeTaskAsync: vi.fn(async () => {
          throw new Error("Agent crashed");
        }),
      });

      await expect(executeCronTaskAsync(task, deps)).rejects.toThrow("Agent crashed");

      expect(deps.openJobLogAsync).toHaveBeenCalledOnce();
      expect(deps.closeJobLog).toHaveBeenCalledOnce();
      expect(deps.closeJobLog).toHaveBeenCalledWith("test-task-id");
    });
  });
});
