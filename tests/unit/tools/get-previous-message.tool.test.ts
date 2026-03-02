import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGetPreviousMessageTool } from "../../../src/tools/get-previous-message.tool.js";
import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";

vi.mock("../../../src/services/cron-message-history.service.js", () => ({
  CronMessageHistoryService: {
    getInstance: vi.fn(),
  },
}));

interface IGetPreviousMessageResult {
  messages: Array<{ messageId: string; content: string; sentAt: string }>;
  summary: string | null;
  summaryGeneratedAt: string | null;
  totalMessageCount: number;
}

async function execTool(tool: ReturnType<typeof createGetPreviousMessageTool>): Promise<IGetPreviousMessageResult> {
  return (tool as any).execute(
    {},
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  ) as Promise<IGetPreviousMessageResult>;
}

describe("get_previous_message tool", () => {
  let mockHistoryService: {
    getHistoryAsync: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoryService = {
      getHistoryAsync: vi.fn(),
    };
    vi.mocked(CronMessageHistoryService.getInstance).mockReturnValue(
      mockHistoryService as unknown as CronMessageHistoryService,
    );
  });

  it("returns empty result when no task id", async () => {
    const taskIdProvider = (): string | null => null;
    const tool = createGetPreviousMessageTool(taskIdProvider);

    const result = await execTool(tool);

    expect(result.messages).toEqual([]);
    expect(result.summary).toBeNull();
    expect(result.totalMessageCount).toBe(0);
  });

  it("returns history from service", async () => {
    const taskIdProvider = (): string | null => "task-123";
    const tool = createGetPreviousMessageTool(taskIdProvider);

    mockHistoryService.getHistoryAsync.mockResolvedValue({
      messages: [
        { messageId: "msg-1", content: "Hello", sentAt: "2024-01-01T10:00:00Z" },
        { messageId: "msg-2", content: "World", sentAt: "2024-01-01T11:00:00Z" },
      ],
      summary: "Previous summary",
      summaryGeneratedAt: "2024-01-01T09:00:00Z",
      totalMessageCount: 3,
    });

    const result = await execTool(tool);

    expect(mockHistoryService.getHistoryAsync).toHaveBeenCalledWith("task-123");
    expect(result.messages).toHaveLength(2);
    expect(result.summary).toBe("Previous summary");
    expect(result.totalMessageCount).toBe(3);
  });

  it("has correct description emphasizing duplicate prevention", () => {
    const tool = createGetPreviousMessageTool(() => null);

    expect(tool.description).toContain("IMPORTANT");
    expect(tool.description).toContain("duplicate");
  });
});
