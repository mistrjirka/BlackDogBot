import { beforeEach, describe, expect, it, vi } from "vitest";

import { LangchainMainAgent } from "../../../src/agent/langchain-main-agent.js";
import { ToolHotReloadService } from "../../../src/services/tool-hot-reload.service.js";

const mocks = vi.hoisted(() => ({
  invokeAgentAsyncMock: vi.fn(),
  createLangchainAgentMock: vi.fn(() => ({}) as any),
}));

vi.mock("../../../src/agent/langchain-agent.js", () => ({
  createLangchainAgent: mocks.createLangchainAgentMock,
  invokeAgentAsync: mocks.invokeAgentAsyncMock,
}));

describe("LangchainMainAgent hot-reload lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (LangchainMainAgent as any)._instance = null;
  });

  it("triggers tool rebuild after each processed message", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-1",
        {
          chatId: "chat-1",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
        },
      ],
    ]);

    mocks.invokeAgentAsyncMock.mockResolvedValue({
      text: "ok",
      stepsCount: 0,
      sendMessageUsed: false,
    });

    const rebuildSpy = vi
      .spyOn(ToolHotReloadService.getInstance(), "triggerRebuildAsync")
      .mockResolvedValue(true);

    await agent.processMessageForChatAsync("chat-1", "hello");

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(rebuildSpy).toHaveBeenCalledWith("chat-1");
  });
});
