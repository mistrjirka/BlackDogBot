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
  suppressedReason?: string;
  suppressedAt?: string;
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
  let context: {
    toolCallHistory: string[];
    taskName?: string;
    taskDescription?: string;
    taskInstructions?: string;
    messageDedupEnabled?: boolean;
  };
  let mockSender: ReturnType<typeof vi.fn>;
  let mockHistoryService: {
    checkMessageDispatchPolicyAsync: ReturnType<typeof vi.fn>;
    checkMessageNoveltyAsync: ReturnType<typeof vi.fn>;
    recordMessageAsync: ReturnType<typeof vi.fn>;
    recordToVectorStoreAsync: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      toolCallHistory: [],
      taskName: "fetch_rageintel_feed",
      taskDescription: "Fetch and process feed updates",
      taskInstructions: "Process feed in silent mode; only send critical alerts.",
      messageDedupEnabled: true,
    };
    mockSender = vi.fn().mockResolvedValue("msg-123");
    mockHistoryService = {
      checkMessageDispatchPolicyAsync: vi.fn().mockResolvedValue({
        shouldDispatch: true,
      }),
      checkMessageNoveltyAsync: vi.fn().mockResolvedValue({
        isNewInformation: true,
        similarCount: 2,
      }),
      recordMessageAsync: vi.fn(),
      recordToVectorStoreAsync: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(CronMessageHistoryService.getInstance).mockReturnValue(
      mockHistoryService as unknown as CronMessageHistoryService,
    );
  });

  it("allows send without requiring get_previous_message", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Hello");

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("msg-123");
    expect(context.toolCallHistory).toContain("send_message");
  });

  it("checks novelty before sending", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Hello");

    expect(mockHistoryService.checkMessageNoveltyAsync).toHaveBeenCalledWith(
      "task-123",
      "Hello",
      context.taskInstructions,
      context.taskName,
      context.taskDescription,
    );
  });

  it("checks dispatch policy before novelty dedup", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Hello");

    expect(mockHistoryService.checkMessageDispatchPolicyAsync).toHaveBeenCalledWith(
      "Hello",
      context.taskInstructions,
      context.taskName,
      context.taskDescription,
    );
  });

  it("returns sent:false with suppression metadata when task policy forbids dispatch", async () => {
    mockHistoryService.checkMessageDispatchPolicyAsync.mockResolvedValue({
      shouldDispatch: false,
    });

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Status update only");

    expect(result.sent).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.suppressedReason).toBe("policy");
    expect(result.suppressedAt).toBeDefined();
    expect(mockSender).not.toHaveBeenCalled();
    expect(mockHistoryService.checkMessageNoveltyAsync).not.toHaveBeenCalled();
  });

  it("returns sent:false with suppression metadata for duplicate messages", async () => {
    mockHistoryService.checkMessageNoveltyAsync.mockResolvedValue({
      isNewInformation: false,
      similarCount: 10,
    });

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Duplicate update");

    expect(result.sent).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.suppressedReason).toBe("duplicate");
    expect(result.suppressedAt).toBeDefined();
    expect(mockSender).not.toHaveBeenCalled();
    expect(mockHistoryService.recordMessageAsync).not.toHaveBeenCalled();
    expect(mockHistoryService.recordToVectorStoreAsync).not.toHaveBeenCalled();
    expect(context.toolCallHistory).toContain("send_message");
  });

  it("skips novelty check when task id is unavailable", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => null, context);

    const result = await execTool(tool, "Hello again");

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("msg-123");
    expect(mockHistoryService.checkMessageNoveltyAsync).not.toHaveBeenCalled();
  });

  it("skips novelty check when messageDedupEnabled is false", async () => {
    context.messageDedupEnabled = false;
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Hello");

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("msg-123");
    expect(mockHistoryService.checkMessageNoveltyAsync).not.toHaveBeenCalled();
    expect(mockHistoryService.checkMessageDispatchPolicyAsync).toHaveBeenCalled();
  });

  it("still runs dispatch policy when messageDedupEnabled is false", async () => {
    context.messageDedupEnabled = false;
    mockHistoryService.checkMessageDispatchPolicyAsync.mockResolvedValue({
      shouldDispatch: false,
    });
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Status update");

    expect(result.sent).toBe(false);
    expect(result.suppressedReason).toBe("policy");
    expect(mockHistoryService.checkMessageDispatchPolicyAsync).toHaveBeenCalled();
    expect(mockHistoryService.checkMessageNoveltyAsync).not.toHaveBeenCalled();
    expect(mockSender).not.toHaveBeenCalled();
  });

  it("tracks send_message in tool call history on success", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Hello");

    expect(context.toolCallHistory).toContain("send_message");
  });

  it("records message in history when send succeeds", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Test message");

    expect(mockHistoryService.recordMessageAsync).toHaveBeenCalledWith(
      "task-123",
      "Test message",
    );
  });

  it("records message to vector store when send succeeds", async () => {
    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    await execTool(tool, "Test message");

    expect(mockHistoryService.recordToVectorStoreAsync).toHaveBeenCalledWith(
      "task-123",
      "Test message",
    );
  });

  it("send succeeds even if vector store recording fails", async () => {
    mockHistoryService.recordToVectorStoreAsync.mockRejectedValue(new Error("Vector store unavailable"));

    const tool = createSendMessageToolWithHistory(mockSender, () => "task-123", context);

    const result = await execTool(tool, "Test message");

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("msg-123");
  });
});
