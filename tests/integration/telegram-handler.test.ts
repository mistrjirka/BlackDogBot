import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { APICallError } from "ai";

import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import { EmbeddingService } from "../../src/services/embedding.service.js";
import { VectorStoreService } from "../../src/services/vector-store.service.js";
import { KnowledgeService } from "../../src/services/knowledge.service.js";
import { JobStorageService } from "../../src/services/job-storage.service.js";
import { JobExecutorService } from "../../src/services/job-executor.service.js";
import { SkillLoaderService } from "../../src/services/skill-loader.service.js";
import { LiteSqlService } from "../../src/services/litesql.service.js";
import { MessagingService, type IPlatformAdapter } from "../../src/services/messaging.service.js";
import { MainAgent } from "../../src/agent/main-agent.js";
import { TelegramHandler } from "../../src/telegram/handler.js";
import type { Context } from "grammy";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
  (EmbeddingService as unknown as { _instance: null })._instance = null;
  (VectorStoreService as unknown as { _instance: null })._instance = null;
  (KnowledgeService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
  (JobExecutorService as unknown as { _instance: null })._instance = null;
  (SkillLoaderService as unknown as { _instance: null })._instance = null;
  (LiteSqlService as unknown as { _instance: null })._instance = null;
  (MessagingService as unknown as { _instance: null })._instance = null;
  (MainAgent as unknown as { _instance: null })._instance = null;
  (TelegramHandler as unknown as { _instance: null })._instance = null;
}

/**
 * Builds a minimal grammY Context stub that satisfies the subset of fields
 * used by TelegramHandler.handleMessageAsync.
 */
function makeCtx(overrides: {
  text?: string;
  chatId?: number;
  userId?: number;
  username?: string;
  messageId?: number;
  replyImpl?: (text: string, options?: unknown) => Promise<unknown>;
}): Context {
  const {
    text = "hello",
    chatId = 100,
    userId = 200,
    username = "tester",
    messageId = 1,
    replyImpl = async (): Promise<void> => {},
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

/**
 * Creates a fake Telegram adapter that implements IPlatformAdapter
 * by capturing all sent messages/photos/actions into the provided arrays.
 */
function createFakeAdapter(
  sentMessages: Array<{ text: string; userId: string }>,
  sentPhotos: Array<{ userId: string; caption: string | null }>,
  sentActions: Array<{ userId: string; action: string }>,
): IPlatformAdapter {
  return {
    platform: "telegram" as const,
    sendMessageAsync: async (message): Promise<string | null> => {
      sentMessages.push({ text: message.text, userId: message.userId });
      return "fake-msg-id";
    },
    sendPhotoAsync: async (photo): Promise<string | null> => {
      sentPhotos.push({ userId: photo.userId, caption: photo.caption });
      return "fake-photo-id";
    },
    sendChatActionAsync: async (userId, action): Promise<void> => {
      sentActions.push({ userId, action });
    },
  };
}

//#endregion Helpers

//#region Tests

describe("TelegramHandler", () => {
  const sentMessages: Array<{ text: string; userId: string }> = [];
  const sentPhotos: Array<{ userId: string; caption: string | null }> = [];
  const sentActions: Array<{ userId: string; action: string }> = [];

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-tg-handler-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    // Initialize services (same pattern as telegram-e2e.test.ts)
    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();

    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();

    aiProviderService.initialize(configService.getConfig().ai);

    const promptService: PromptService = PromptService.getInstance();

    await promptService.initializeAsync();

    const embeddingService: EmbeddingService = EmbeddingService.getInstance();

    await embeddingService.initializeAsync();

    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
    const lanceDbPath: string = path.join(tempDir, ".betterclaw", "knowledge", "lancedb");

    await vectorStoreService.initializeAsync(lanceDbPath);

    const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();

    await skillLoaderService.loadAllSkillsAsync([]);

    // Register fake Telegram adapter on MessagingService
    const messagingService: MessagingService = MessagingService.getInstance();

    messagingService.registerAdapter(createFakeAdapter(sentMessages, sentPhotos, sentActions));
  }, 350000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset per-test state
    sentMessages.length = 0;
    sentPhotos.length = 0;
    sentActions.length = 0;

    // Clear TelegramHandler's _processing set so each test starts clean
    const handler: TelegramHandler = TelegramHandler.getInstance();

    (handler as unknown as { _processing: Set<string> })._processing.clear();

    // Clear MainAgent sessions so each test gets a fresh conversation
    const mainAgent: MainAgent = MainAgent.getInstance();

    mainAgent.clearChatHistory("100");
    mainAgent.clearChatHistory("42");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should process a normal message end-to-end without error", async () => {
    // Arrange
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const ctx: Context = makeCtx({ text: "Say 'pong' and call done." });

    // Act — real LLM call via MainAgent
    await handler.handleMessageAsync(ctx);

    // Assert — typing action was sent, no crash occurred
    expect(sentActions.some((a) => a.action === "typing")).toBe(true);
  }, 300000);

  it("should reply with agent text when the agent returns non-empty text", async () => {
    // Arrange
    const replyTexts: string[] = [];
    const ctx: Context = makeCtx({
      text: "Say 'pong' and nothing else.",
      replyImpl: async (text: string): Promise<{ message_id: number }> => {
        replyTexts.push(text);
        return { message_id: 99999 };
      },
    });
    const handler: TelegramHandler = TelegramHandler.getInstance();

    // Act — real LLM call
    await handler.handleMessageAsync(ctx);

    // Assert — ctx.reply was called with some non-empty text from the agent
    expect(replyTexts.length).toBeGreaterThan(0);
    expect(replyTexts[0].length).toBeGreaterThan(0);
  }, 300000);

  it("should skip processing when ctx.message is absent", async () => {
    // Arrange — context has no message at all
    const ctx: Context = { message: undefined } as unknown as Context;
    const handler: TelegramHandler = TelegramHandler.getInstance();

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert — no typing actions were sent (agent was never touched)
    expect(sentActions.length).toBe(0);
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

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert — no typing actions were sent
    expect(sentActions.length).toBe(0);
  });

  it("should skip a second message for the same chat while the first is still processing", async () => {
    // Arrange — mock processMessageForChatAsync to block the first call
    const mainAgent: MainAgent = MainAgent.getInstance();

    let releaseFirst!: () => void;
    const firstStarted: Promise<void> = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let callCount: number = 0;

    vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async () => {
      callCount++;
      releaseFirst();
      // Block indefinitely to simulate slow processing
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

    // The hanging first call will never resolve, so we just let it go
    void firstCall;
  });

  it("should send an error reply when the agent throws", async () => {
    // Arrange — spy on processMessageForChatAsync to throw a controlled error
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
    // Arrange — spy on processMessageForChatAsync to throw an APICallError
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

    // Act
    await handler.handleMessageAsync(ctx);

    // Assert — user reply includes actionable provider info
    // ctx.reply is also called for the progress message, so search all calls for the error reply
    const allReplies: string[] = replySpy.mock.calls.map((call: unknown[]): string => call[0] as string);
    const userReply: string | undefined = allReplies.find((r: string): boolean => r.includes("Authentication failed"));

    expect(userReply).toBeDefined();
    expect(userReply).toContain("Authentication failed");
    expect(userReply).toContain("openrouter.ai");
    expect(userReply).toContain("minimax/minimax-m2.5");
  });

  it("should log but not throw when even the error reply fails", async () => {
    // Arrange — spy on processMessageForChatAsync to throw AND ctx.reply also throws
    const mainAgent: MainAgent = MainAgent.getInstance();

    vi
      .spyOn(mainAgent, "processMessageForChatAsync")
      .mockRejectedValue(new Error("agent boom"));

    const ctx: Context = makeCtx({
      text: "trigger error",
      replyImpl: async (): Promise<void> => {
        throw new Error("reply failed");
      },
    });

    const handler: TelegramHandler = TelegramHandler.getInstance();

    // Act — must NOT throw even though both the agent and the reply fail
    await expect(handler.handleMessageAsync(ctx)).resolves.toBeUndefined();
  });
});

//#endregion Tests
