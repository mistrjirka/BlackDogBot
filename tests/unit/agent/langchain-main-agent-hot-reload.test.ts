import { beforeEach, describe, expect, it, vi } from "vitest";

import { LangchainMainAgent } from "../../../src/agent/langchain-main-agent.js";
import { ToolHotReloadService } from "../../../src/services/tool-hot-reload.service.js";
import type { IRebuildResult } from "../../../src/services/tool-hot-reload.service.js";

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
    vi.resetAllMocks();
    mocks.createLangchainAgentMock.mockImplementation(() => ({}) as any);
    (LangchainMainAgent as any)._instance = null;
    (ToolHotReloadService as any)._instance = null;
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
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
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
          await onToolEndAsync("create_table", { tableName: "items" }, buildToolMessage("create_table", { success: true, tableName: "items" }), false);
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
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-1");
        session.tools = [{ name: "write_table_items" }];
        return {
          success: true,
          perTableTools: {
            write_table_items: { name: "write_table_items" } as any,
          },
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-1", "hello");

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(rebuildSpy).toHaveBeenCalledWith("chat-1");
    expect(mocks.createLangchainAgentMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[0][1]).toBe("hello");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("write_table_items");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("update_table_items");
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
  });

  it("handles multiple tool-change resumes without throwing unexpected error", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-2",
        {
          chatId: "chat-2",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
        },
      ],
    ]);

    mocks.invokeAgentAsyncMock
      .mockImplementationOnce(async (_agent, _text, _threadId, _images, _onStepAsync, onToolEndAsync) => {
        if (onToolEndAsync) {
          await onToolEndAsync("create_table", { tableName: "t1" }, buildToolMessage("create_table", { success: true, tableName: "t1" }), false);
        }
        return {
          text: "partial-1",
          stepsCount: 1,
          sendMessageUsed: false,
          toolsChanged: true,
        };
      })
      .mockImplementationOnce(async (_agent, _text, _threadId, _images, _onStepAsync, onToolEndAsync) => {
        if (onToolEndAsync) {
          await onToolEndAsync("create_table", { tableName: "t2" }, buildToolMessage("create_table", { success: true, tableName: "t2" }), false);
        }
        return {
          text: "partial-2",
          stepsCount: 1,
          sendMessageUsed: false,
          toolsChanged: true,
        };
      })
      .mockResolvedValueOnce({
        text: "done",
        stepsCount: 1,
        sendMessageUsed: false,
        toolsChanged: false,
      });

    let rebuildCount = 0;
    const rebuildSpy = vi.spyOn(ToolHotReloadService.getInstance(), "triggerRebuildAsync")
      .mockImplementation(async (): Promise<IRebuildResult> => {
        rebuildCount += 1;
        const session = agent._sessions.get("chat-2");
        if (rebuildCount === 3) {
          session.tools = [{ name: "write_table_t1" }];
        } else if (rebuildCount === 6) {
          session.tools = [{ name: "write_table_t1" }, { name: "write_table_t2" }];
        }

        return {
          success: true,
          perTableTools: {
            write_table_t1: { name: "write_table_t1" } as any,
            write_table_t2: { name: "write_table_t2" } as any,
          },
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-2", "hello");

    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(3);
    expect(rebuildSpy).toHaveBeenCalledTimes(6);
  });

  function buildToolMessage(toolName: string, toolResult: Record<string, unknown>): Record<string, unknown> {
    return {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        status: toolResult.success === true ? "success" : "error",
        content: JSON.stringify(toolResult),
      },
    };
  }

  it("triggers hot-reload when create_table returns ToolMessage with success in kwargs.content", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-toolmsg",
        {
          chatId: "chat-toolmsg",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
        },
      ],
    ]);

    const toolMessage = buildToolMessage("create_table", {
      success: true,
      tableName: "logs",
      message: "Table \"logs\" created.",
    });

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
          await onToolEndAsync("create_table", { tableName: "logs" }, toolMessage, false);
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
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-toolmsg");
        session.tools = [{ name: "write_table_logs" }];
        return {
          success: true,
          perTableTools: {
            write_table_logs: { name: "write_table_logs" } as any,
          },
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-toolmsg", "hello");

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(rebuildSpy).toHaveBeenCalledWith("chat-toolmsg");
    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("write_table_logs");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("update_table_logs");
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
  });

  it("sends system message even when rebuild callback clobbers lastAddedTableNames", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-clobber",
        {
          chatId: "chat-clobber",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
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
          await onToolEndAsync("create_table", { tableName: "logs" }, buildToolMessage("create_table", { success: true, tableName: "logs" }), false);
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

    vi.spyOn(ToolHotReloadService.getInstance(), "triggerRebuildAsync")
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-clobber");
        session.tools = [{ name: "write_table_logs" }];
        // Production _rebuildToolsForChat no longer overwrites lastAddedTableNames.
        // Returning addedTableNames: [] simulates real rebuild result
        // while verifying the code does NOT clobber the pushed table name.
        return {
          success: true,
          perTableTools: {
            write_table_logs: { name: "write_table_logs" } as any,
          },
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-clobber", "hello");

    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("write_table_logs");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("update_table_logs");
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
  });

  it("sends system message about removed tool after drop_table", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-drop",
        {
          chatId: "chat-drop",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
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
          await onToolEndAsync("drop_table", { tableName: "old_logs" }, buildToolMessage("drop_table", { success: true, tableName: "old_logs" }), false);
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

    vi.spyOn(ToolHotReloadService.getInstance(), "triggerRebuildAsync")
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-drop");
        session.tools = [];
        return {
          success: true,
          perTableTools: {},
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-drop", "hello");

    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("write_table_old_logs");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("update_table_old_logs");
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
  });

  it("triggers hot-reload when create_table returns raw JSON string output", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-json-string",
        {
          chatId: "chat-json-string",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
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
          await onToolEndAsync(
            "create_table",
            { tableName: "logs_json" },
            JSON.stringify({ success: true, tableName: "logs_json" }),
            false,
          );
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
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-json-string");
        session.tools = [{ name: "write_table_logs_json" }];
        return {
          success: true,
          perTableTools: {
            write_table_logs_json: { name: "write_table_logs_json" } as any,
          },
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-json-string", "hello");

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("write_table_logs_json");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("update_table_logs_json");
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
  });

  it("triggers hot-reload when create_table returns plain ToolMessage-shaped output", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-plain-toolmsg",
        {
          chatId: "chat-plain-toolmsg",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
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
          await onToolEndAsync(
            "create_table",
            { tableName: "logs_plain" },
            {
              type: "tool",
              status: "success",
              tool_call_id: "tc-plain-1",
              content: JSON.stringify({ success: true, tableName: "logs_plain" }),
            },
            false,
          );
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
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-plain-toolmsg");
        session.tools = [{ name: "write_table_logs_plain" }];
        return {
          success: true,
          perTableTools: {
            write_table_logs_plain: { name: "write_table_logs_plain" } as any,
          },
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-plain-toolmsg", "hello");

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("write_table_logs_plain");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("update_table_logs_plain");
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);
  });

  it("does not trigger hot-reload for failed create_table", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-3",
        {
          chatId: "chat-3",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
        },
      ],
    ]);

    mocks.invokeAgentAsyncMock.mockImplementationOnce(async (_agent, _text, _threadId, _images, _onStepAsync, onToolEndAsync) => {
      if (onToolEndAsync) {
        await onToolEndAsync("create_table", { tableName: "broken_table" }, buildToolMessage("create_table", { success: false, error: "syntax error" }), false);
      }

      return {
        text: "failed create_table handled",
        stepsCount: 1,
        sendMessageUsed: false,
        toolsChanged: false,
      };
    });

    const rebuildSpy = vi
      .spyOn(ToolHotReloadService.getInstance(), "triggerRebuildAsync")
      .mockImplementation(async (): Promise<IRebuildResult> => ({
        success: true,
        perTableTools: {},
        cronTools: {
          add_cron: { name: "add_cron" } as any,
          edit_cron: { name: "edit_cron" } as any,
          edit_cron_instructions: { name: "edit_cron_instructions" } as any,
        },
        addedTableNames: [],
        removedTableNames: [],
      }));

    const result = await agent.processMessageForChatAsync("chat-3", "hello");

    expect(result.text).toBe("failed create_table handled");
    expect(rebuildSpy).toHaveBeenCalledTimes(0);
  });

  it("throws when create_table succeeds but hot-reload cannot add expected tool", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-reload-fail",
        {
          chatId: "chat-reload-fail",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
        },
      ],
    ]);

    mocks.invokeAgentAsyncMock.mockImplementationOnce(async (
      _agent,
      _text,
      _threadId,
      _images,
      _onStepAsync,
      onToolEndAsync,
    ) => {
      if (onToolEndAsync) {
        await onToolEndAsync(
          "create_table",
          { tableName: "missing_tool" },
          {
            type: "tool",
            status: "success",
            tool_call_id: "tc-missing-1",
            content: JSON.stringify({ success: true, tableName: "missing_tool" }),
          },
          false,
        );
      }

      return {
        text: "should not complete",
        stepsCount: 1,
        sendMessageUsed: false,
        toolsChanged: false,
      };
    });

    mocks.invokeAgentAsyncMock.mockResolvedValueOnce({
      text: "continued unexpectedly",
      stepsCount: 1,
      sendMessageUsed: false,
      toolsChanged: false,
    });

    vi.spyOn(ToolHotReloadService.getInstance(), "triggerRebuildAsync")
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-reload-fail");
        session.tools = [];
        return {
          success: true,
          perTableTools: {},
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    await expect(agent.processMessageForChatAsync("chat-reload-fail", "hello"))
      .rejects
      .toThrow("hot-reload failed to add expected tool \"write_table_missing_tool\"");
  });

  it("hot-reloads update_table_<tableName> when create_table succeeds", async () => {
    const agent = LangchainMainAgent.getInstance() as any;

    agent._baseSystemPrompt = "test prompt";
    agent._aiConfig = { provider: "openai", model: "gpt-4o-mini" };
    agent._checkpointer = { deleteThread: vi.fn() };
    agent._sessions = new Map([
      [
        "chat-update-tool",
        {
          chatId: "chat-update-tool",
          platform: "telegram",
          messageSender: vi.fn(),
          photoSender: vi.fn(),
          onStepAsync: undefined,
          tools: [],
          readTracker: {},
          lastAddedTableNames: [],
          lastDroppedTableNames: [],
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
          await onToolEndAsync("create_table", { tableName: "users" }, buildToolMessage("create_table", { success: true, tableName: "users" }), false);
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
      .mockImplementation(async (): Promise<IRebuildResult> => {
        const session = agent._sessions.get("chat-update-tool");
        session.tools = [{ name: "write_table_users" }, { name: "update_table_users" }];
        return {
          success: true,
          perTableTools: {
            write_table_users: { name: "write_table_users" } as any,
            update_table_users: { name: "update_table_users" } as any,
          },
          cronTools: {
            add_cron: { name: "add_cron" } as any,
            edit_cron: { name: "edit_cron" } as any,
            edit_cron_instructions: { name: "edit_cron_instructions" } as any,
          },
          addedTableNames: [],
          removedTableNames: [],
        };
      });

    const result = await agent.processMessageForChatAsync("chat-update-tool", "hello");

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(rebuildSpy).toHaveBeenCalledWith("chat-update-tool");
    expect(mocks.invokeAgentAsyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("write_table_users");
    expect(mocks.invokeAgentAsyncMock.mock.calls[1][1]).toContain("update_table_users");
    expect(result.text).toBe("done");
    expect(result.stepsCount).toBe(3);

    const session = agent._sessions.get("chat-update-tool");
    expect(session!.tools.some((t: any) => t.name === "write_table_users")).toBe(true);
    expect(session!.tools.some((t: any) => t.name === "update_table_users")).toBe(true);
  });
});
