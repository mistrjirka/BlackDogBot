import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APICallError } from "ai";

import { TelegramHandler } from "../../src/telegram/handler.js";
import { MainAgent } from "../../src/agent/main-agent.js";
import { MessagingService } from "../../src/services/messaging.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import type { Context } from "grammy";

//#region Helpers

/**
 * Resets all singletons involved in TelegramHandler so each test starts clean.
 * TelegramHandler itself uses a private static _instance that must also be reset.
 */
function resetSingletons(): void {
  (TelegramHandler as unknown as { _instance: null })._instance = null;
  (MainAgent as unknown as { _instance: null })._instance = null;
  (MessagingService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

/**
 * Builds a minimal grammy Context stub that satisfies the subset of fields
 * used by TelegramHandler.handleMessageAsync.
 */
function makeCtx(overrides: {
  text?: string;
  chatId?: number;
  userId?: number;
  username?: string;
  messageId?: number;
  replyImpl?: () => Promise<void>;
}): Context {
  const {
    text = "hello",
    chatId = 100,
    userId = 200,
    username = "tester",
    messageId = 1,
    replyImpl = async () => {},
  } = overrides;

  const message: Record<string, unknown> = {
    message_id: messageId,
    text,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, is_bot: false, first_name: username, username },
  };

  return {
    message,
    reply: replyImpl,
  } as unknown as Context;
}

//#endregion Helpers

//#region Tests

describe("TelegramHandler", () => {
  beforeEach(() => {
    resetSingletons();

    // Silence logger — mark it as initialized but with noop transport
    const logger: LoggerService = LoggerService.getInstance();
    (logger as unknown as { _initialized: boolean })._initialized = true;
    (logger as unknown as { info: unknown }).info = vi.fn();
    (logger as unknown as { warn: unknown }).warn = vi.fn();
    (logger as unknown as { error: unknown }).error = vi.fn();
    (logger as unknown as { debug: unknown }).debug = vi.fn();

    // Stub MessagingService.createSenderForChat to return a noop sender
    const messagingService: MessagingService = MessagingService.getInstance();
    vi
      .spyOn(messagingService, "createSenderForChat")
      .mockReturnValue(async () => null);

    // Stub MainAgent methods so no real LLM is called
    const mainAgent: MainAgent = MainAgent.getInstance();
    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({
      text: "",
      stepsCount: 1,
    });
    vi.spyOn(mainAgent, "clearChatHistory").mockReturnValue(undefined);
  });

  afterEach(() => {
    resetSingletons();
    vi.restoreAllMocks();
  });

  it("should process a normal message end-to-end without error", async () => {
    // Arrange
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const ctx: Context = makeCtx({ text: "ping" });

    // Act — should not throw
    await handler.handleMessageAsync(ctx);

    // Assert — agent was initialized and called
    const mainAgent: MainAgent = MainAgent.getInstance();

    expect(mainAgent.initializeForChatAsync).toHaveBeenCalledWith(
      "100",
      expect.any(Function),
    );
    expect(mainAgent.processMessageForChatAsync).toHaveBeenCalledWith("100", "ping");
  });

  it("should reply with agent text when the agent returns non-empty text", async () => {
    // Arrange — agent returns text output
    const mainAgent: MainAgent = MainAgent.getInstance();
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({
      text: "pong",
      stepsCount: 1,
    });

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const ctx: Context = makeCtx({ text: "ping", replyImpl: replySpy });
    const handler: TelegramHandler = TelegramHandler.getInstance();

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert — ctx.reply was called with the agent's text
    expect(replySpy).toHaveBeenCalledWith("pong", expect.any(Object));
  });

  it("should skip processing when ctx.message is absent", async () => {
    // Arrange — context has no message at all
    const ctx: Context = { message: undefined } as unknown as Context;
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const mainAgent: MainAgent = MainAgent.getInstance();

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert — agent was never touched
    expect(mainAgent.initializeForChatAsync).not.toHaveBeenCalled();
  });

  it("should skip processing when message has no text", async () => {
    // Arrange — message present but text is undefined (e.g. a photo message)
    const ctx: Context = {
      message: {
        message_id: 1,
        date: Date.now(),
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false, first_name: "user" },
        // no text field
      },
    } as unknown as Context;

    const handler: TelegramHandler = TelegramHandler.getInstance();
    const mainAgent: MainAgent = MainAgent.getInstance();

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert
    expect(mainAgent.initializeForChatAsync).not.toHaveBeenCalled();
  });

  it("should skip a second message for the same chat while the first is still processing", async () => {
    // Arrange — the first call blocks until we release a promise; the second call comes in before release
    let releaseFirst!: () => void;
    const firstStarted: Promise<void> = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const mainAgent: MainAgent = MainAgent.getInstance();

    let callCount: number = 0;

    vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async () => {
      callCount++;
      releaseFirst();
      // Block indefinitely until test cleans up — simulate slow processing
      await new Promise<void>(() => {});

      return { text: "", stepsCount: 1 };
    });

    const ctx: Context = makeCtx({ chatId: 42 });
    const handler: TelegramHandler = TelegramHandler.getInstance();

    // Start first call (will block)
    const firstCall: Promise<void> = handler.handleMessageAsync(ctx);

    // Wait until first call has actually started processing
    await firstStarted;

    // Start second call for the same chat — should be dropped
    await handler.handleMessageAsync(ctx);

    // Second call should complete immediately (skipped), first is still pending
    expect(callCount).toBe(1);

    // Cleanup — cancel the first call by restoring the mock so the test can finish
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({
      text: "",
      stepsCount: 1,
    });

    // The hanging first call will never resolve, so we don't await it
    void firstCall;
  });

  it("should send an error reply when the agent throws", async () => {
    // Arrange — agent throws
    const mainAgent: MainAgent = MainAgent.getInstance();
    vi
      .spyOn(mainAgent, "processMessageForChatAsync")
      .mockRejectedValue(new Error("agent boom"));

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const ctx: Context = makeCtx({ text: "trigger error", replyImpl: replySpy });
    const handler: TelegramHandler = TelegramHandler.getInstance();

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert — error reply was sent with the error message
    expect(replySpy).toHaveBeenCalledWith(
      expect.stringContaining("agent boom"),
    );
  });

  it("should include provider details in error reply when an APICallError is thrown", async () => {
    // Arrange — agent throws an APICallError (like OpenRouter returning "User not found.")
    const mainAgent: MainAgent = MainAgent.getInstance();
    const apiError: APICallError = new APICallError({
      message: "User not found.",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: { model: "minimax/minimax-m2.5", messages: [] },
      statusCode: 401,
      responseBody: '{"error":{"message":"User not found."}}',
      isRetryable: false,
    });
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockRejectedValue(apiError);

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const ctx: Context = makeCtx({ text: "trigger api error", replyImpl: replySpy });
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const logger: LoggerService = LoggerService.getInstance();

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert — user reply includes actionable provider info
    const userReply: string = replySpy.mock.calls[0][0];
    expect(userReply).toContain("Authentication failed");
    expect(userReply).toContain("openrouter.ai");
    expect(userReply).toContain("minimax/minimax-m2.5");

    // Assert — log includes structured error details
    expect(logger.error).toHaveBeenCalledWith(
      "Error processing Telegram message",
      expect.objectContaining({
        statusCode: 401,
        provider: "openrouter.ai",
        model: "minimax/minimax-m2.5",
      }),
    );
  });

  it("should log but not throw when even the error reply fails", async () => {
    // Arrange — agent throws AND ctx.reply also throws
    const mainAgent: MainAgent = MainAgent.getInstance();
    vi
      .spyOn(mainAgent, "processMessageForChatAsync")
      .mockRejectedValue(new Error("agent boom"));

    const ctx: Context = makeCtx({
      text: "trigger error",
      replyImpl: async () => {
        throw new Error("reply failed");
      },
    });

    const handler: TelegramHandler = TelegramHandler.getInstance();
    const logger: LoggerService = LoggerService.getInstance();

    // Act — must NOT throw even though both the agent and the reply fail
    await expect(handler.handleMessageAsync(ctx)).resolves.toBeUndefined();

    // Assert — the inner reply failure was logged
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to send error reply",
      expect.any(Object),
    );
  });
});

//#endregion Tests
