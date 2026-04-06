import { beforeEach, describe, expect, it, vi } from "vitest";

import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";
import { createStructuredOutputModel } from "../../../src/services/langchain-model.service.js";
import { ConfigService } from "../../../src/services/config.service.js";

vi.mock("../../../src/services/langchain-model.service.js", () => ({
  createStructuredOutputModel: vi.fn(),
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

    const mockInvoke = vi.fn().mockRejectedValue(
      new Error("Schema validation failed"),
    );
    vi.mocked(createStructuredOutputModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    await expect(service.checkMessageNoveltyAsync(
      "task-1",
      "Candidate message",
      "Only send when new",
      "Test task",
      "Task desc",
    )).rejects.toThrow("Schema validation failed");
  });

  it("throws when dispatch policy structured output parsing fails", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(
      new Error("Schema validation failed"),
    );
    vi.mocked(createStructuredOutputModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    await expect(service.checkMessageDispatchPolicyAsync(
      "Candidate message",
      "Send only critical alerts",
      "Test task",
      "Task desc",
    )).rejects.toThrow("Schema validation failed");
  });

  it("parses novelty decision correctly", async () => {
    vi.spyOn(service, "getSimilarMessagesAsync").mockResolvedValue([
      {
        content: "Similar old message",
        sentAt: "2026-03-01T00:00:00.000Z",
        score: 0.95,
        taskId: "task-1",
      },
    ]);

    const mockInvoke = vi.fn().mockResolvedValue({
      isNewInformation: true,
      reasoning: "new details included",
    });

    vi.mocked(createStructuredOutputModel).mockReturnValue({
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

  it("uses withStructuredOutput for dispatch policy", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      shouldDispatch: false,
      reasoning: "matches policy",
    });

    vi.mocked(createStructuredOutputModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    const result = await service.checkMessageDispatchPolicyAsync(
      "Candidate message",
      "Send only critical alerts",
      "Test task",
      "Task desc",
    );

    expect(result.shouldDispatch).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
