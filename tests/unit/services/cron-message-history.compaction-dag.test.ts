import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

vi.mock("../../../src/utils/summarization-compaction.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/utils/summarization-compaction.js")>(
    "../../../src/utils/summarization-compaction.js",
  );

  return {
    ...actual,
    compactMessagesSummaryOnlyAsync: vi.fn(),
  };
});

import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";
import * as summarizationCompaction from "../../../src/utils/summarization-compaction.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("CronMessageHistoryService - DAG Compaction", () => {
  let mockLogger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    (CronMessageHistoryService as any)._sharedHistory = [];
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockLogger = makeLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("when threshold exceeded", () => {
    it("calls DAG compactor instead of local summarizer", async () => {
      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service as any, "_logger", "get").mockReturnValue(mockLogger);
      vi.spyOn(AiProviderService, "getInstance").mockReturnValue({
        getModel: vi.fn().mockReturnValue({} as LanguageModel),
      } as unknown as AiProviderService);

      vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync).mockResolvedValue({
        messages: [],
        passes: 1,
        originalTokens: 1000,
        compactedTokens: 200,
        converged: true,
        dagPath: ["L1"],
        dagNodeVisitCounts: { L1: 1, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0, L7: 0 },
        dagTerminationReason: "reached_target_after_node",
        maxLevelReached: "L1" as const,
      });

      const largeMessage = "x".repeat(30000);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);

      expect(summarizationCompaction.compactMessagesSummaryOnlyAsync).toHaveBeenCalled();
    });
  });

  describe("on success", () => {
    it("compacts shared history and keeps it bounded", async () => {
      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service as any, "_logger", "get").mockReturnValue(mockLogger);
      vi.spyOn(AiProviderService, "getInstance").mockReturnValue({
        getModel: vi.fn().mockReturnValue({} as LanguageModel),
      } as unknown as AiProviderService);

      vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync).mockResolvedValue({
        messages: [
          { role: "user" as const, content: "Recent message" },
        ],
        passes: 1,
        originalTokens: 1000,
        compactedTokens: 200,
        converged: true,
        dagPath: ["L1"],
        dagNodeVisitCounts: { L1: 1, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0, L7: 0 },
        dagTerminationReason: "reached_target_after_node",
        maxLevelReached: "L1" as const,
      });

      const largeMessage = "x".repeat(30000);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);

      const result = await service.getHistoryAsync();
      expect(result.messages.length).toBeLessThanOrEqual(3);
    });

    it("logs compaction metadata path proving DAG usage", async () => {
      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service as any, "_logger", "get").mockReturnValue(mockLogger);
      vi.spyOn(AiProviderService, "getInstance").mockReturnValue({
        getModel: vi.fn().mockReturnValue({} as LanguageModel),
      } as unknown as AiProviderService);

      const dagResult = {
        messages: [{ role: "user" as const, content: "Recent" }],
        passes: 2,
        originalTokens: 1000,
        compactedTokens: 200,
        converged: true,
        dagPath: ["L1", "L2", "L1"],
        dagNodeVisitCounts: { L1: 2, L2: 1, L3: 0, L4: 0, L5: 0, L6: 0, L7: 0 },
        dagTerminationReason: "reached_target_after_node",
        maxLevelReached: "L2" as const,
      };
      vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync).mockResolvedValue(dagResult);

      const largeMessage = "x".repeat(30000);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Cron message history compacted via DAG",
        expect.objectContaining({
          dagPath: ["L1", "L2", "L1"],
          dagNodeVisitCounts: { L1: 2, L2: 1, L3: 0, L4: 0, L5: 0, L6: 0, L7: 0 },
          dagTerminationReason: "reached_target_after_node",
          maxLevelReached: "L2",
        }),
      );
    });
  });

  describe("on compaction throw", () => {
    it("service continues and history is bounded", async () => {
      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service as any, "_logger", "get").mockReturnValue(mockLogger);
      vi.spyOn(AiProviderService, "getInstance").mockReturnValue({
        getModel: vi.fn().mockReturnValue({} as LanguageModel),
      } as unknown as AiProviderService);

      vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync).mockRejectedValue(
        new Error("Compaction failed"),
      );

      const largeMessage = "x".repeat(30000);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);

      const result = await service.getHistoryAsync();
      expect(result.messages.length).toBeLessThanOrEqual(3);
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it("logs error but does not throw", async () => {
      const service = CronMessageHistoryService.getInstance();
      vi.spyOn(service as any, "_logger", "get").mockReturnValue(mockLogger);
      vi.spyOn(AiProviderService, "getInstance").mockReturnValue({
        getModel: vi.fn().mockReturnValue({} as LanguageModel),
      } as unknown as AiProviderService);

      vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync).mockRejectedValue(
        new Error("Compaction failed"),
      );

      const largeMessage = "x".repeat(30000);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);
      await service.recordMessageAsync("task-1", largeMessage);

      await expect(service.recordMessageAsync("task-1", largeMessage)).resolves.not.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Cron message history DAG compaction failed, using bounded fallback",
        expect.objectContaining({
          error: "Compaction failed",
        }),
      );
    });
  });
});
