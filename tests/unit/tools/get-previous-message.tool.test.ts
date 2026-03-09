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
  let context: { toolCallHistory: string[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoryService = {
      getHistoryAsync: vi.fn(),
    };
    vi.mocked(CronMessageHistoryService.getInstance).mockReturnValue(
      mockHistoryService as unknown as CronMessageHistoryService,
    );
    context = { toolCallHistory: [] };
  });

  it("returns empty result and tracks tool call", async () => {
    mockHistoryService.getHistoryAsync.mockResolvedValue({
      messages: [],
      summary: null,
      summaryGeneratedAt: null,
      totalMessageCount: 0,
    });

    const tool = createGetPreviousMessageTool(context);

    const result = await execTool(tool);

    expect(result.messages).toEqual([]);
    expect(result.summary).toBeNull();
    expect(result.totalMessageCount).toBe(0);
    expect(context.toolCallHistory).toContain("get_previous_message");
  });

  it("returns history from service and tracks tool call", async () => {
    mockHistoryService.getHistoryAsync.mockResolvedValue({
      messages: [
        { messageId: "msg-1", content: "Hello", sentAt: "2024-01-01T10:00:00Z" },
        { messageId: "msg-2", content: "World", sentAt: "2024-01-01T11:00:00Z" },
      ],
      summary: "Previous summary",
      summaryGeneratedAt: "2024-01-01T09:00:00Z",
      totalMessageCount: 3,
    });

    const tool = createGetPreviousMessageTool(context);
    const result = await execTool(tool);

    expect(mockHistoryService.getHistoryAsync).toHaveBeenCalledOnce();
    expect(result.messages).toHaveLength(2);
    expect(result.summary).toBe("Previous summary");
    expect(result.totalMessageCount).toBe(3);
    expect(context.toolCallHistory).toContain("get_previous_message");
  });

  it("has correct description emphasizing shared history", () => {
    const tool = createGetPreviousMessageTool({ toolCallHistory: [] });

    expect(tool.description).toContain("any cron task in the system");
    expect(tool.description).toContain("IMPORTANT");
    expect(tool.description).toContain("duplicate");
  });
});
