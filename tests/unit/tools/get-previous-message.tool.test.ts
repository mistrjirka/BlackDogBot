import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGetPreviousMessageTool } from "../../../src/tools/get-previous-message.tool.js";
import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";

vi.mock("../../../src/services/cron-message-history.service.js", () => ({
  CronMessageHistoryService: {
    getInstance: vi.fn(),
  },
}));

interface IGetPreviousMessageResult {
  similarMessages: Array<{ content: string; sentAt: string; score: number; taskId: string }>;
  message: string;
}

async function execTool(
  tool: ReturnType<typeof createGetPreviousMessageTool>,
  input: Record<string, unknown>,
): Promise<IGetPreviousMessageResult> {
  return (tool as any).execute(
    input,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  ) as Promise<IGetPreviousMessageResult>;
}

describe("get_previous_message tool", () => {
  let mockHistoryService: {
    getSimilarMessagesAsync: ReturnType<typeof vi.fn>;
  };
  let context: { toolCallHistory: string[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoryService = {
      getSimilarMessagesAsync: vi.fn(),
    };
    vi.mocked(CronMessageHistoryService.getInstance).mockReturnValue(
      mockHistoryService as unknown as CronMessageHistoryService,
    );
    context = { toolCallHistory: [] };
  });

  it("returns similar messages and tracks tool call", async () => {
    mockHistoryService.getSimilarMessagesAsync.mockResolvedValue([
      { content: "BTC price is $85,432", sentAt: "2024-01-01T10:00:00Z", score: 0.97, taskId: "task-1" },
      { content: "ETH price update", sentAt: "2024-01-01T11:00:00Z", score: 0.82, taskId: "task-1" },
    ]);

    const tool = createGetPreviousMessageTool(context);

    const result = await execTool(tool, { message: "BTC price is $85,500" });

    expect(result.similarMessages).toHaveLength(2);
    expect(result.similarMessages[0].content).toBe("BTC price is $85,432");
    expect(result.similarMessages[0].score).toBe(0.97);
    expect(result.message).toContain("Consider whether sending this message is necessary");
    expect(context.toolCallHistory).toContain("get_previous_message");
    expect(mockHistoryService.getSimilarMessagesAsync).toHaveBeenCalledWith("BTC price is $85,500");
  });

  it("returns empty array when no similar messages found", async () => {
    mockHistoryService.getSimilarMessagesAsync.mockResolvedValue([]);

    const tool = createGetPreviousMessageTool(context);

    const result = await execTool(tool, { message: "Brand new topic" });

    expect(result.similarMessages).toHaveLength(0);
    expect(result.message).toContain("Consider whether sending this message is necessary");
    expect(context.toolCallHistory).toContain("get_previous_message");
  });

  it("returns messages from different tasks", async () => {
    mockHistoryService.getSimilarMessagesAsync.mockResolvedValue([
      { content: "Weather alert", sentAt: "2024-01-01T08:00:00Z", score: 0.95, taskId: "weather-task" },
      { content: "Weather summary", sentAt: "2024-01-01T09:00:00Z", score: 0.88, taskId: "daily-task" },
    ]);

    const tool = createGetPreviousMessageTool(context);

    const result = await execTool(tool, { message: "Today's weather forecast" });

    expect(result.similarMessages).toHaveLength(2);
    expect(result.similarMessages[0].taskId).toBe("weather-task");
    expect(result.similarMessages[1].taskId).toBe("daily-task");
  });

  it("throws when embeddings are not configured", async () => {
    mockHistoryService.getSimilarMessagesAsync.mockRejectedValue(
      new Error("Embeddings not configured. Cron message dedup requires an embedding provider."),
    );

    const tool = createGetPreviousMessageTool(context);

    await expect(execTool(tool, { message: "Test message" })).rejects.toThrow(
      "Embeddings not configured",
    );
  });

  it("throws when vector store is not initialized", async () => {
    mockHistoryService.getSimilarMessagesAsync.mockRejectedValue(
      new Error("Vector store not initialized."),
    );

    const tool = createGetPreviousMessageTool(context);

    await expect(execTool(tool, { message: "Test message" })).rejects.toThrow(
      "Vector store not initialized",
    );
  });

  it("has correct description emphasizing similarity search", () => {
    const tool = createGetPreviousMessageTool({ toolCallHistory: [] });

    expect(tool.description).toContain("similarity");
    expect(tool.description).toContain("before send_message");
    expect(tool.description).toContain("send_message");
    expect(tool.description).toContain("message you intend to send");
  });
});
