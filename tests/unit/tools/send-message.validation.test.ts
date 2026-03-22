import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSendMessageToolWithHistory } from "../../../src/tools/send-message.tool.js";
import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";

vi.mock("../../../src/services/cron-message-history.service.js", () => ({
  CronMessageHistoryService: {
    getInstance: vi.fn(),
  },
}));

interface ISendMessageResult {
  sent: boolean;
  messageId: string | null;
  error?: string;
}

async function execTool(
  tool: ReturnType<typeof createSendMessageToolWithHistory>,
  message: string,
): Promise<ISendMessageResult> {
  return (tool as any).execute(
    { message },
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  ) as Promise<ISendMessageResult>;
}

describe("send_message tool with validation", () => {
  let context: { toolCallHistory: string[] };
  let mockSender: ReturnType<typeof vi.fn>;
  let mockHistoryService: { recordMessageAsync: ReturnType<typeof vi.fn>; recordToVectorStoreAsync: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    context = { toolCallHistory: [] };
    mockSender = vi.fn().mockResolvedValue("msg-123");
    mockHistoryService = {
      recordMessageAsync: vi.fn(),
      recordToVectorStoreAsync: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(CronMessageHistoryService.getInstance).mockReturnValue(
      mockHistoryService as unknown as CronMessageHistoryService,
    );
  });

  it("returns error when get_previous_message not called first", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Hello");

    expect(result.sent).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toContain("get_previous_message");
    expect(context.toolCallHistory).not.toContain("send_message");
  });

  it("allows send after get_previous_message is called", async () => {
    context.toolCallHistory.push("get_previous_message");

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Hello");

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("msg-123");
    expect(context.toolCallHistory).toContain("send_message");
  });

  it("allows send if get_previous_message was called earlier in execution", async () => {
    context.toolCallHistory.push("get_previous_message");
    context.toolCallHistory.push("other_tool");

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Hello");

    expect(result.sent).toBe(true);
  });

  it("returns error even if send_message was already called in this execution", async () => {
    // Simulate that get_previous_message is never called, but send_message might have been attempted
    context.toolCallHistory.push("send_message"); // This should not bypass validation for new sends
    context.toolCallHistory.push("think");

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Hello again");

    expect(result.sent).toBe(false);
    expect(result.error).toContain("get_previous_message");
  });

  it("tracks send_message in tool call history on success", async () => {
    context.toolCallHistory.push("get_previous_message");

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Hello");

    expect(context.toolCallHistory).toContain("send_message");
  });

  it("records message in history when send succeeds", async () => {
    context.toolCallHistory.push("get_previous_message");

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Test message");

    expect(mockHistoryService.recordMessageAsync).toHaveBeenCalledWith(
      "task-123",
      "Test message",
    );
  });

  it("records message to vector store when send succeeds", async () => {
    context.toolCallHistory.push("get_previous_message");

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Test message");

    expect(mockHistoryService.recordToVectorStoreAsync).toHaveBeenCalledWith(
      "task-123",
      "Test message",
    );
  });

  it("send succeeds even if vector store recording fails", async () => {
    context.toolCallHistory.push("get_previous_message");
    mockHistoryService.recordToVectorStoreAsync.mockRejectedValue(new Error("Vector store unavailable"));

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Test message");

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("msg-123");
  });

  it("returns error with helpful message", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Hello");

    expect(result.error).toBe(
      "You must call get_previous_message first to see what previous messages were sent."
    );
  });
});
