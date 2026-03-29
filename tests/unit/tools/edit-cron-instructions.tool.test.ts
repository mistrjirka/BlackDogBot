import { beforeEach, describe, expect, it, vi } from "vitest";

import { editCronInstructionsTool } from "../../../src/tools/edit-cron-instructions.tool.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { createChatModel } from "../../../src/services/langchain-model.service.js";

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
  createChatModel: vi.fn(),
}));

vi.mock("../../../src/utils/cron-tool-context.js", () => ({
  buildCronToolContextBlockAsync: vi.fn(async () => "Available tools: send_message"),
}));

describe("edit_cron_instructions tool", () => {
  const existingTask = {
    taskId: "task-123",
    name: "Daily report",
    description: "Sends daily report",
    instructions: "Fetch data and send report",
    tools: ["send_message"],
    schedule: { type: "interval", intervalMs: 3600000 },
    notifyUser: true,
    enabled: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
  } as any;

  let mockScheduler: {
    getTaskAsync: ReturnType<typeof vi.fn>;
    updateTaskAsync: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockScheduler = {
      getTaskAsync: vi.fn().mockResolvedValue(existingTask),
      updateTaskAsync: vi.fn().mockResolvedValue({
        ...existingTask,
        instructions: "Updated instructions",
        updatedAt: "2026-03-01T01:00:00.000Z",
      }),
    };

    vi.mocked(SchedulerService.getInstance).mockReturnValue(mockScheduler as unknown as SchedulerService);
    vi.mocked(ConfigService.getInstance).mockReturnValue({
      getAiConfig: vi.fn(() => ({ provider: "openai", model: "gpt-4o-mini" })),
    } as unknown as ConfigService);
  });

  it("rejects update when verifier returns isClear=false", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      content: '{"isClear":false,"missingContext":"Missing endpoint URL"}',
      additional_kwargs: {},
    });

    vi.mocked(createChatModel).mockReturnValue({ invoke: mockInvoke } as any);

    const result = await (editCronInstructionsTool as any).invoke({
      taskId: "task-123",
      instructions: "Use the API and send summary",
      intention: "Need API-based processing",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("EDIT REJECTED");
    expect(mockScheduler.updateTaskAsync).not.toHaveBeenCalled();
  });

  it("parses verifier JSON from reasoning_content", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      content: "",
      additional_kwargs: {
        reasoning_content: '{"isClear":true,"missingContext":""}',
      },
    });

    vi.mocked(createChatModel).mockReturnValue({ invoke: mockInvoke } as any);

    const result = await (editCronInstructionsTool as any).invoke({
      taskId: "task-123",
      instructions: "Updated instructions",
      intention: "Clarify behavior",
    });

    expect(result.success).toBe(true);
    expect(mockScheduler.updateTaskAsync).toHaveBeenCalledTimes(1);
  });

  it("does not rely on withStructuredOutput for verifier", async () => {
    const mockWithStructuredOutput = vi.fn(() => {
      throw new Error("withStructuredOutput should not be used for verifier path");
    });
    const mockInvoke = vi.fn().mockResolvedValue({
      content: '{"isClear":true,"missingContext":""}',
      additional_kwargs: {},
    });

    vi.mocked(createChatModel).mockReturnValue({
      withStructuredOutput: mockWithStructuredOutput,
      invoke: mockInvoke,
    } as any);

    const result = await (editCronInstructionsTool as any).invoke({
      taskId: "task-123",
      instructions: "Updated instructions",
      intention: "Clarify behavior",
    });

    expect(result.success).toBe(true);
    expect(mockWithStructuredOutput).not.toHaveBeenCalled();
  });
});
