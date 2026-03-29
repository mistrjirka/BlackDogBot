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

  it("rebuilds and resumes within one message when tools change mid-stream", async () => {
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

    mocks.invokeAgentAsyncMock
      .mockImplementationOnce(async (
        _agent,
        _text,
        _threadId,
        _images,
        _onStepAsync,
        onToolEndAsync,
      ) => {
        if (onToolEndAsync) {
          await onToolEndAsync("create_table");
        }

        return {
          text: "partial",
          stepsCount: 1,
          sendMessageUsed: false,
          toolsChanged: true,
        };
      })
      .mockResolvedValueOnce({
        text: "done",
        stepsCount: 2,
        sendMessageUsed: false,
        toolsChanged: false,
      });

    const rebuildSpy = vi
      .spyOn(ToolHotReloadService.getInstance(), "triggerRebuildAsync")
      .mockImplementation(async () => {
        const session = agent._sessions.get("chat-1");
        session.tools = [{ name: "write_table_items" }];
        return true;
      });

    const result = await agent.processMessageForChatAsync("chat-1", "hello");

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(rebuildSpy).toHaveBeenCalledWith("chat-1");
    expect(mocks.createLangchainAgentMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[0][1]).toBe("hello");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toBeNull();
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
  });
});
