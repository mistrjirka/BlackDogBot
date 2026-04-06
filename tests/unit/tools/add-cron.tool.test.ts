import { beforeEach, describe, expect, it, vi } from "vitest";

import { addCronTool } from "../../../src/tools/add-cron.tool.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { createStructuredOutputModel } from "../../../src/services/langchain-model.service.js";

vi.mock("../../../src/services/scheduler.service.js", () => ({
  SchedulerService: {
    getInstance: vi.fn(),
  },
}));

vi.mock("../../../src/services/config.service.js", () => ({
  ConfigService: {
    getInstance: vi.fn(),
  },
}));

vi.mock("../../../src/services/langchain-model.service.js", () => ({
  createStructuredOutputModel: vi.fn(),
}));

vi.mock("../../../src/utils/cron-tool-context.js", () => ({
  buildCronToolContextBlockAsync: vi.fn(async () => "Available tools: send_message"),
}));

interface IAddCronResult {
  taskId: string;
  success: boolean;
  error?: string;
}

describe("add_cron tool", () => {
  let mockScheduler: { addTaskAsync: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockScheduler = {
      addTaskAsync: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(SchedulerService.getInstance).mockReturnValue(
      mockScheduler as unknown as SchedulerService,
    );

    vi.mocked(ConfigService.getInstance).mockReturnValue({
      getAiConfig: vi.fn(() => ({ provider: "openai", model: "gpt-4o-mini" })),
    } as unknown as ConfigService);
  });

  it("fails when verifier model call fails", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(
      new Error("400 Failed to initialize samplers: std::exception"),
    );
    vi.mocked(createStructuredOutputModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    const result = await (addCronTool as any).invoke({
      name: "test-task",
      description: "Test cron",
      instructions: "Print hello world and notify user.",
      tools: ["send_message"],
      scheduleType: "interval",
      scheduleIntervalMs: 3600000,
      notifyUser: true,
    }) as IAddCronResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain("400 Failed to initialize samplers");
    expect(mockScheduler.addTaskAsync).not.toHaveBeenCalled();
  });

  it("rejects ambiguous instructions when verifier returns isClear=false", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      isClear: false,
      missingContext: "Missing explicit feed URL.",
    });
    vi.mocked(createStructuredOutputModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    const result = await (addCronTool as any).invoke({
      name: "ambiguous-task",
      description: "Ambiguous cron",
      instructions: "Fetch that feed and do what we discussed.",
      tools: ["send_message"],
      scheduleType: "interval",
      scheduleIntervalMs: 3600000,
      notifyUser: true,
    }) as IAddCronResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain("CRON REJECTED");
    expect(mockScheduler.addTaskAsync).not.toHaveBeenCalled();
  });

  it("adds cron task when verifier returns isClear=true", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      isClear: true,
      missingContext: "",
    });
    vi.mocked(createStructuredOutputModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    const result = await (addCronTool as any).invoke({
      name: "clear-task",
      description: "Clear cron",
      instructions: "Fetch https://example.com/feed and send summary via send_message.",
      tools: ["send_message"],
      scheduleType: "interval",
      scheduleIntervalMs: 3600000,
      notifyUser: true,
    }) as IAddCronResult;

    expect(result.success).toBe(true);
    expect(result.taskId).toBeTruthy();
    expect(mockScheduler.addTaskAsync).toHaveBeenCalledTimes(1);
  });

  it("uses withStructuredOutput for verifier", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      isClear: true,
      missingContext: "",
    });
    vi.mocked(createStructuredOutputModel).mockReturnValue({
      invoke: mockInvoke,
    } as any);

    const result = await (addCronTool as any).invoke({
      name: "structured-output-task",
      description: "Cron using structured output",
      instructions: "Fetch https://example.com/feed and send summary via send_message.",
      tools: ["send_message"],
      scheduleType: "interval",
      scheduleIntervalMs: 3600000,
      notifyUser: true,
    }) as IAddCronResult;

    expect(result.success).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
