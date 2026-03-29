import { beforeEach, describe, expect, it, vi } from "vitest";

import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";
import { createChatModel } from "../../../src/services/langchain-model.service.js";
import { ConfigService } from "../../../src/services/config.service.js";

vi.mock("../../../src/services/langchain-model.service.js", () => ({
  createChatModel: vi.fn(),
}));

vi.mock("../../../src/services/config.service.js", () => ({
  ConfigService: {
    getInstance: vi.fn(),
  },
}));

describe("CronMessageHistoryService structured output behavior", () => {
  let service: CronMessageHistoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    (CronMessageHistoryService as any)._instance = null;
    (CronMessageHistoryService as any)._sharedHistory = [];
    vi.mocked(ConfigService.getInstance).mockReturnValue({
      getAiConfig: vi.fn(() => ({ provider: "openai", model: "gpt-4o-mini" })),
    } as unknown as ConfigService);
    service = CronMessageHistoryService.getInstance();
  });

  it("throws when novelty structured output parsing fails", async () => {
    vi.spyOn(service, "getSimilarMessagesAsync").mockResolvedValue([
      {
        content: "Similar old message",
        sentAt: "2026-03-01T00:00:00.000Z",
        score: 0.95,
        taskId: "task-1",
      },
    ]);

    const mockInvoke = vi.fn().mockResolvedValue({
      content: "not-json",
      additional_kwargs: {},
    });
    vi.mocked(createChatModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    await expect(service.checkMessageNoveltyAsync(
      "task-1",
      "Candidate message",
      "Only send when new",
      "Test task",
      "Task desc",
    )).rejects.toThrow("returned invalid structured response");
  });

  it("throws when dispatch policy structured output parsing fails", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      content: "still-not-json",
      additional_kwargs: {},
    });
    vi.mocked(createChatModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    await expect(service.checkMessageDispatchPolicyAsync(
      "Candidate message",
      "Send only critical alerts",
      "Test task",
      "Task desc",
    )).rejects.toThrow("returned invalid structured response");
  });

  it("parses novelty decision from reasoning_content", async () => {
    vi.spyOn(service, "getSimilarMessagesAsync").mockResolvedValue([
      {
        content: "Similar old message",
        sentAt: "2026-03-01T00:00:00.000Z",
        score: 0.95,
        taskId: "task-1",
      },
    ]);

    const mockInvoke = vi.fn().mockResolvedValue({
      content: "",
      additional_kwargs: {
        reasoning_content: '{"reasoning":"new details included","isNewInformation":true}',
      },
    });

    vi.mocked(createChatModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    const result = await service.checkMessageNoveltyAsync(
      "task-1",
      "Candidate message",
      "Only send when new",
      "Test task",
      "Task desc",
    );

    expect(result.isNewInformation).toBe(true);
    expect(result.similarCount).toBe(1);
  });

  it("does not rely on withStructuredOutput for dispatch policy", async () => {
    const mockWithStructuredOutput = vi.fn(() => {
      throw new Error("withStructuredOutput should not be used");
    });
    const mockInvoke = vi.fn().mockResolvedValue({
      content: '{"reasoning":"matches policy","shouldDispatch":false}',
      additional_kwargs: {},
    });

    vi.mocked(createChatModel).mockReturnValue({
      withStructuredOutput: mockWithStructuredOutput,
      invoke: mockInvoke,
    } as any);

    const result = await service.checkMessageDispatchPolicyAsync(
      "Candidate message",
      "Send only critical alerts",
      "Test task",
      "Task desc",
    );

    expect(result.shouldDispatch).toBe(false);
    expect(mockWithStructuredOutput).not.toHaveBeenCalled();
  });
});
