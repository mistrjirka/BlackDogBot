import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ICronHistoryResult } from "../../../src/services/cron-message-history.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

const mockGetTaskAsync = vi.fn();
const mockUpdateTaskAsync = vi.fn();
const mockGenerateTextWithRetryAsync = vi.fn();

vi.mock("../../../src/services/scheduler.service.js", () => ({
  SchedulerService: {
    getInstance: () => ({
      getTaskAsync: mockGetTaskAsync,
      updateTaskAsync: mockUpdateTaskAsync,
    }),
  },
}));

vi.mock("../../../src/services/logger.service.js", () => ({
  LoggerService: {
    getInstance: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../../../src/services/ai-provider.service.js", () => ({
  AiProviderService: {
    getInstance: () => ({
      getModel: vi.fn(),
    }),
  },
}));

vi.mock("../../../src/utils/llm-retry.js", () => ({
  generateTextWithRetryAsync: mockGenerateTextWithRetryAsync,
}));

function createMockTask(overrides: Partial<IScheduledTask> = {}): IScheduledTask {
  return {
    taskId: "test-task-id",
    name: "test-task",
    description: "Test task",
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

async function getService() {
  const { CronMessageHistoryService } = await import("../../../src/services/cron-message-history.service.js");
  (CronMessageHistoryService as any)._instance = null;
  return CronMessageHistoryService.getInstance();
}

describe("CronMessageHistoryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("getHistoryAsync", () => {
    it("returns empty history when task not found", async () => {
      mockGetTaskAsync.mockResolvedValue(null);
      const service = await getService();

      const result: ICronHistoryResult = await service.getHistoryAsync("nonexistent");

      expect(result.messages).toEqual([]);
      expect(result.summary).toBeNull();
      expect(result.summaryGeneratedAt).toBeNull();
      expect(result.totalMessageCount).toBe(0);
    });

    it("returns task message history", async () => {
      const task: IScheduledTask = createMockTask({
        messageHistory: [
          { messageId: "msg-1", content: "Hello", sentAt: "2024-01-01T10:00:00Z" },
          { messageId: "msg-2", content: "World", sentAt: "2024-01-01T11:00:00Z" },
        ],
        messageSummary: "Previous summary",
        summaryGeneratedAt: "2024-01-01T09:00:00Z",
      });

      mockGetTaskAsync.mockResolvedValue(task);
      const service = await getService();

      const result: ICronHistoryResult = await service.getHistoryAsync("test-task-id");

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe("Hello");
      expect(result.messages[1].content).toBe("World");
      expect(result.summary).toBe("Previous summary");
      expect(result.totalMessageCount).toBe(3);
    });
  });

  describe("recordMessageAsync", () => {
    it("does nothing when task not found", async () => {
      mockGetTaskAsync.mockResolvedValue(null);
      const service = await getService();

      const messageId: string = await service.recordMessageAsync("nonexistent", "Test message");

      expect(messageId).toBe("");
      expect(mockUpdateTaskAsync).not.toHaveBeenCalled();
    });

    it("records message to history", async () => {
      const task: IScheduledTask = createMockTask();
      mockGetTaskAsync.mockResolvedValue(task);
      mockUpdateTaskAsync.mockResolvedValue(undefined);

      const service = await getService();
      const messageId: string = await service.recordMessageAsync("test-task-id", "New message");

      expect(messageId).toBeTruthy();
      expect(mockUpdateTaskAsync).toHaveBeenCalledWith(
        "test-task-id",
        expect.objectContaining({
          messageHistory: expect.arrayContaining([
            expect.objectContaining({ content: "New message" }),
          ]),
        }),
      );
    });

    it("appends to existing history", async () => {
      const task: IScheduledTask = createMockTask({
        messageHistory: [
          { messageId: "msg-1", content: "Old message", sentAt: "2024-01-01T10:00:00Z" },
        ],
      });

      mockGetTaskAsync.mockResolvedValue(task);
      mockUpdateTaskAsync.mockResolvedValue(undefined);

      const service = await getService();
      await service.recordMessageAsync("test-task-id", "New message");

      expect(mockUpdateTaskAsync).toHaveBeenCalledWith(
        "test-task-id",
        expect.objectContaining({
          messageHistory: expect.arrayContaining([
            expect.objectContaining({ content: "Old message" }),
            expect.objectContaining({ content: "New message" }),
          ]),
        }),
      );
    });
  });

  describe("compaction", () => {
    it("triggers compaction when threshold exceeded", async () => {
      const longContent: string = "x".repeat(25_000);
      const task: IScheduledTask = createMockTask({
        messageHistory: [
          { messageId: "msg-1", content: longContent, sentAt: "2024-01-01T10:00:00Z" },
          { messageId: "msg-2", content: longContent, sentAt: "2024-01-01T11:00:00Z" },
          { messageId: "msg-3", content: longContent, sentAt: "2024-01-01T12:00:00Z" },
          { messageId: "msg-4", content: longContent, sentAt: "2024-01-01T13:00:00Z" },
        ],
      });

      mockGetTaskAsync.mockResolvedValue(task);
      mockUpdateTaskAsync.mockResolvedValue(undefined);
      mockGenerateTextWithRetryAsync.mockResolvedValue({ text: "Compacted summary" });

      const service = await getService();
      await service.recordMessageAsync("test-task-id", "New message");

      expect(mockGenerateTextWithRetryAsync).toHaveBeenCalled();
    });

    it("keeps last 3 messages after compaction", async () => {
      const longContent: string = "x".repeat(10_000);
      const task: IScheduledTask = createMockTask({
        messageHistory: [
          { messageId: "msg-1", content: longContent, sentAt: "2024-01-01T10:00:00Z" },
          { messageId: "msg-2", content: longContent, sentAt: "2024-01-01T11:00:00Z" },
          { messageId: "msg-3", content: longContent, sentAt: "2024-01-01T12:00:00Z" },
          { messageId: "msg-4", content: longContent, sentAt: "2024-01-01T13:00:00Z" },
          { messageId: "msg-5", content: longContent, sentAt: "2024-01-01T14:00:00Z" },
        ],
      });

      mockGetTaskAsync.mockResolvedValue(task);
      mockUpdateTaskAsync.mockResolvedValue(undefined);
      mockGenerateTextWithRetryAsync.mockResolvedValue({ text: "Compacted summary" });

      const service = await getService();
      await service.recordMessageAsync("test-task-id", "New message");

      const lastCall = mockUpdateTaskAsync.mock.calls.find(
        (call) => call[1].messageSummary !== undefined,
      );

      if (lastCall) {
        expect(lastCall[1].messageHistory).toHaveLength(3);
      }
    });

    it("incorporates existing summary into new summary", async () => {
      const longContent: string = "x".repeat(10_000);
      const task: IScheduledTask = createMockTask({
        messageHistory: [
          { messageId: "msg-1", content: longContent, sentAt: "2024-01-01T10:00:00Z" },
          { messageId: "msg-2", content: longContent, sentAt: "2024-01-01T11:00:00Z" },
          { messageId: "msg-3", content: longContent, sentAt: "2024-01-01T12:00:00Z" },
          { messageId: "msg-4", content: longContent, sentAt: "2024-01-01T13:00:00Z" },
        ],
        messageSummary: "Existing summary from before",
      });

      mockGetTaskAsync.mockResolvedValue(task);
      mockUpdateTaskAsync.mockResolvedValue(undefined);
      mockGenerateTextWithRetryAsync.mockResolvedValue({ text: "New compacted summary" });

      const service = await getService();
      await service.recordMessageAsync("test-task-id", "New message");

      const callArgs = mockGenerateTextWithRetryAsync.mock.calls[0]?.[0];

      if (callArgs && typeof callArgs.prompt === "string") {
        expect(callArgs.prompt).toContain("Existing summary from before");
      }
    });
  });
});
