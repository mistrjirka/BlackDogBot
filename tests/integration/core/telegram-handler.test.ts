import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { APICallError } from "ai";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { EmbeddingService } from "../../../src/services/embedding.service.js";
import { VectorStoreService } from "../../../src/services/vector-store.service.js";
import * as knowledge from "../../../src/helpers/knowledge.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { JobExecutorService } from "../../../src/services/job-executor.service.js";
import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import * as litesql from "../../../src/helpers/litesql.js";
import { MessagingService, type IPlatformAdapter } from "../../../src/services/messaging.service.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { MainAgent } from "../../../src/agent/main-agent.js";
import { TelegramHandler } from "../../../src/platforms/telegram/handler.js";
import type { ITelegramConfig } from "../../../src/platforms/telegram/types.js";
import type { IPlatformDeps } from "../../../src/platforms/types.js";
import type { Context } from "grammy";
import * as toolRegistry from "../../../src/helpers/tool-registry.js";


let tempDir: string;
let originalHome: string;


function createMockTelegramConfig(allowedUsers?: string[]): ITelegramConfig {
  return {
    botToken: "test-token",
    allowedUsers,
  };
}

function createMockDeps(): IPlatformDeps {
  return {
    mainAgent: MainAgent.getInstance(),
    messagingService: MessagingService.getInstance(),
    channelRegistry: ChannelRegistryService.getInstance(),
    toolRegistry,
    logger: LoggerService.getInstance(),
  };
}

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


//#region Tests

describe("TelegramHandler", () => {
  const sentMessages: Array<{ text: string; userId: string }> = [];
  const sentPhotos: Array<{ userId: string; caption: string | null }> = [];
  const sentActions: Array<{ userId: string; action: string }> = [];

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-tg-handler-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();

    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();

    aiProviderService.initialize(configService.getConfig().ai);

    const promptService: PromptService = PromptService.getInstance();

    await promptService.initializeAsync();

    const loadedConfig = configService.getConfig();

    const embeddingService: EmbeddingService = EmbeddingService.getInstance();

    await embeddingService.initializeAsync(
      loadedConfig.knowledge.embeddingModelPath,
      loadedConfig.knowledge.embeddingDtype,
      loadedConfig.knowledge.embeddingDevice,
      loadedConfig.knowledge.embeddingProvider,
      loadedConfig.knowledge.embeddingOpenRouterModel,
      loadedConfig.knowledge.embeddingOpenRouterApiKey ?? loadedConfig.ai.openrouter?.apiKey,
    );

    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
    const lanceDbPath: string = path.join(tempDir, ".blackdogbot", "knowledge", "lancedb");

    await vectorStoreService.initializeAsync(
      lanceDbPath,
      embeddingService.getDimension(),
    );

    const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();

    await skillLoaderService.loadAllSkillsAsync([]);

    const messagingService: MessagingService = MessagingService.getInstance();

    messagingService.registerAdapter(createFakeAdapter(sentMessages, sentPhotos, sentActions));

    const channelRegistry = ChannelRegistryService.getInstance();
    await channelRegistry.initializeAsync();

    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.initializeAsync(createMockTelegramConfig(), createMockDeps());
  }, 600000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sentMessages.length = 0;
    sentPhotos.length = 0;
    sentActions.length = 0;

    const handler: TelegramHandler = TelegramHandler.getInstance();

    (handler as unknown as { _processing: Set<string> })._processing.clear();

    const mainAgent: MainAgent = MainAgent.getInstance();

    mainAgent.clearChatHistory("100");
    mainAgent.clearChatHistory("42");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should process a normal message end-to-end without error", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const ctx: Context = makeCtx({ text: "Say 'pong'." });

    await handler.handleMessageAsync(ctx);

    expect(sentActions.some((a) => a.action === "typing")).toBe(true);
  }, 600000);

  it("should reply with agent text when the agent returns non-empty text", async () => {
    const replyTexts: string[] = [];
    const ctx: Context = makeCtx({
      text: "Say 'pong' and nothing else.",
      replyImpl: async (text: string): Promise<{ message_id: number }> => {
        replyTexts.push(text);
        return { message_id: 99999 };
      },
    });
    const handler: TelegramHandler = TelegramHandler.getInstance();

    await handler.handleMessageAsync(ctx);

    expect(replyTexts.length).toBeGreaterThan(0);
    expect(replyTexts[0].length).toBeGreaterThan(0);
  }, 600000);

  it("should skip processing when ctx.message is absent", async () => {
    const ctx: Context = { message: undefined } as unknown as Context;
    const handler: TelegramHandler = TelegramHandler.getInstance();

    await handler.handleMessageAsync(ctx);

    expect(sentActions.length).toBe(0);
  });

  it("should skip processing when message has no text", async () => {
    const ctx: Context = {
      message: {
        message_id: 1,
        date: Date.now(),
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false, first_name: "user" },
      },
    } as unknown as Context;

    const handler: TelegramHandler = TelegramHandler.getInstance();

    await handler.handleMessageAsync(ctx);

    expect(sentActions.length).toBe(0);
  });

  it("should queue and merge subsequent messages for the same chat while first is still processing", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();

    let resolveBlock: () => void;
    const blockPromise: Promise<void> = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });

    let callCount: number = 0;

    const processSpy = vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async (_chatId, text) => {
      callCount++;
      if (callCount === 1) {
        await blockPromise;
      }
      return { text, stepsCount: 1 };
    });

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const ctx1: Context = makeCtx({ chatId: 100, text: "first", replyImpl: replySpy });
    const ctx2: Context = makeCtx({ chatId: 100, text: "second", replyImpl: replySpy });
    const ctx3: Context = makeCtx({ chatId: 100, text: "third", replyImpl: replySpy });
    const handler: TelegramHandler = TelegramHandler.getInstance();

    const firstCall: Promise<void> = handler.handleMessageAsync(ctx1);

    await vi.waitUntil(() => callCount === 1, { timeout: 30000 });

    await handler.handleMessageAsync(ctx2);
    await handler.handleMessageAsync(ctx3);

    expect(callCount).toBe(1);

    resolveBlock!();
    await firstCall;

    await vi.waitUntil(() => callCount === 2, { timeout: 30000 });

    const secondInvocationArgs: unknown[] = processSpy.mock.calls[1] ?? [];

    expect(secondInvocationArgs[1]).toBe("second\nthird");
  }, 600000);

  it("should recover merged queued processing on context overflow by compacting and retrying", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const mainAgent: MainAgent = MainAgent.getInstance();

    (handler as unknown as { _bot: unknown })._bot = null;

    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);

    const compactSpy = vi
      .spyOn(mainAgent, "compactSessionMessagesForChatAsync")
      .mockResolvedValue(true);

    let processCallCount: number = 0;
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async () => {
      processCallCount++;
      if (processCallCount === 1) {
        throw new Error("Context size exceeded: context_length_exceeded");
      }

      return { text: "Recovered response", stepsCount: 1 };
    });

    await (handler as unknown as {
      _processMergedQueuedMessageAsync: (chatId: string, queuedMessages: Array<{ text: string; messageId: number | null; imageAttachments: unknown[] }>) => Promise<void>
    })._processMergedQueuedMessageAsync("100", [
      {
        text: "queued message that overflows",
        messageId: null,
        imageAttachments: [],
      },
    ]);

    expect(processCallCount).toBe(2);
    expect(compactSpy).toHaveBeenCalledTimes(1);
  }, 600000);

  it("should send an error reply when the agent throws", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();

    vi
      .spyOn(mainAgent, "processMessageForChatAsync")
      .mockRejectedValue(new Error("agent boom"));

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const ctx: Context = makeCtx({ text: "trigger error", replyImpl: replySpy });
    const handler: TelegramHandler = TelegramHandler.getInstance();

    await handler.handleMessageAsync(ctx);

    expect(replySpy).toHaveBeenCalledWith(
      expect.stringContaining("agent boom"),
    );
  }, 600000);

  it("should escape HTML in progress trace tool calls", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();

    let capturedOnStep: ((stepNumber: number, toolCalls: Array<{ name: string; input: Record<string, unknown> }>) => Promise<void>) | undefined;

    vi.spyOn(mainAgent, "initializeForChatAsync").mockImplementation(async (
      _chatId,
      _sender,
      _photoSender,
      onStepAsync,
    ) => {
      capturedOnStep = onStepAsync;
    });

    vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async () => {
      if (capturedOnStep) {
        await capturedOnStep(1, [{
          name: "run_cmd",
          input: {
            command: "echo <unsafe>&\"chars\"",
          },
        }]);
      }

      return {
        text: "Done",
        stepsCount: 1,
      };
    });

    const editMessageTextSpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const ctx: Context = makeCtx({
      chatId: 100,
      text: "run tool",
      replyImpl: async (): Promise<{ message_id: number }> => ({ message_id: 6001 }),
    });
    (ctx as unknown as { api?: unknown }).api = {
      editMessageText: editMessageTextSpy,
    };

    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.handleMessageAsync(ctx);

    expect(editMessageTextSpy).toHaveBeenCalled();

    const serializedCalls: string = JSON.stringify(editMessageTextSpy.mock.calls);
    expect(serializedCalls).toContain("&lt;unsafe&gt;");
    expect(serializedCalls).toContain("&amp;");
    expect(serializedCalls).not.toContain("<unsafe>");
  }, 600000);

  it("should cancel in-flight run, delete prompt, and clear all queued messages on /cancel", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();

    let resolveBlock: () => void;
    const blockPromise: Promise<void> = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });

    let processCallCount: number = 0;

    vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async (_chatId, text) => {
      processCallCount++;
      if (processCallCount === 1) {
        await blockPromise;
        return { text: "Operation was stopped.", stepsCount: 0 };
      }
      return { text, stepsCount: 1 };
    });

    const stopSpy = vi.spyOn(mainAgent, "stopChat").mockReturnValue(true);
    const deleteSpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);

    const firstCtx: Context = makeCtx({
      chatId: 100,
      messageId: 101,
      text: "prompt1",
      replyImpl: async (): Promise<{ message_id: number }> => ({ message_id: 5001 }),
    });
    (firstCtx as unknown as { api?: unknown }).api = { deleteMessage: deleteSpy, editMessageText: vi.fn().mockResolvedValue(undefined) };

    const queuedCtx: Context = makeCtx({
      chatId: 100,
      messageId: 102,
      text: "queued2",
      replyImpl: async (): Promise<{ message_id: number }> => ({ message_id: 5002 }),
    });
    (queuedCtx as unknown as { api?: unknown }).api = { deleteMessage: deleteSpy, editMessageText: vi.fn().mockResolvedValue(undefined) };

    const queuedCtx2: Context = makeCtx({
      chatId: 100,
      messageId: 104,
      text: "queued3",
      replyImpl: async (): Promise<{ message_id: number }> => ({ message_id: 5004 }),
    });
    (queuedCtx2 as unknown as { api?: unknown }).api = { deleteMessage: deleteSpy, editMessageText: vi.fn().mockResolvedValue(undefined) };

    const cancelReplies: string[] = [];
    const cancelCtx: Context = makeCtx({
      chatId: 100,
      messageId: 103,
      text: "/cancel",
      replyImpl: async (text: string): Promise<{ message_id: number }> => {
        cancelReplies.push(text);
        return { message_id: 5003 };
      },
    });
    (cancelCtx as unknown as { api?: unknown }).api = { deleteMessage: deleteSpy, editMessageText: vi.fn().mockResolvedValue(undefined) };

    const handler: TelegramHandler = TelegramHandler.getInstance();

    const firstCall: Promise<void> = handler.handleMessageAsync(firstCtx);
    await vi.waitUntil(() => processCallCount === 1, { timeout: 30000 });

    await handler.handleMessageAsync(queuedCtx);
    await handler.handleMessageAsync(queuedCtx2);
    await handler.handleMessageAsync(cancelCtx);

    resolveBlock!();
    await firstCall;

    expect(stopSpy).toHaveBeenCalledWith("100");
    expect(deleteSpy).toHaveBeenCalledWith("100", 5001);
    expect(deleteSpy).toHaveBeenCalledWith("100", 102);
    expect(deleteSpy).toHaveBeenCalledWith("100", 104);
    expect(cancelReplies.some((reply: string): boolean => reply.toLowerCase().includes("cancelled"))).toBe(true);
    expect(cancelReplies.some((reply: string): boolean => reply.toLowerCase().includes("cleared 2 queued messages"))).toBe(true);
  }, 600000);

  it("should include provider details in error reply when an APICallError is thrown", async () => {
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

    await handler.handleMessageAsync(ctx);

    const allReplies: string[] = replySpy.mock.calls.map((call: unknown[]): string => call[0] as string);
    const userReply: string | undefined = allReplies.find((r: string): boolean => r.includes("Authentication failed"));

    expect(userReply).toBeDefined();
    expect(userReply).toContain("Authentication failed");
    expect(userReply).toContain("openrouter.ai");
    expect(userReply).toContain("minimax/minimax-m2.5");
  }, 600000);

  it("should log but not throw when even the error reply fails", async () => {
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

    await expect(handler.handleMessageAsync(ctx)).resolves.toBeUndefined();
  }, 600000);

  it("should treat 'message is not modified' as noise (no warning) on primary path", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const loggerService: LoggerService = LoggerService.getInstance();
    const warnSpy = vi.spyOn(loggerService, "warn").mockClear();

    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({ text: "Done", stepsCount: 1 });

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ message_id: 6001 });
    const editMessageTextSpy: ReturnType<typeof vi.fn> = vi.fn()
      .mockRejectedValue(new Error("Bad Request: message is not modified"));

    const ctx: Context = makeCtx({
      chatId: 100,
      text: "test",
      replyImpl: replySpy,
    });
    (ctx as unknown as { api?: unknown }).api = {
      editMessageText: editMessageTextSpy,
    };

    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.handleMessageAsync(ctx);

    expect(editMessageTextSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Telegram editMessageText failed"),
      expect.anything(),
    );
  }, 600000);

  it("should handle 'message too long' gracefully on primary path (triggers retry path)", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const loggerService: LoggerService = LoggerService.getInstance();
    const warnSpy = vi.spyOn(loggerService, "warn").mockClear();

    let capturedOnStep: ((stepNumber: number, toolCalls: Array<{ name: string; input: Record<string, unknown> }>) => Promise<void>) | undefined;

    vi.spyOn(mainAgent, "initializeForChatAsync").mockImplementation(async (
      _chatId,
      _sender,
      _photoSender,
      onStepAsync,
    ) => {
      capturedOnStep = onStepAsync;
    });

    const longArg = "echo " + "x".repeat(5000);
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async () => {
      if (capturedOnStep) {
        await capturedOnStep(1, [{ name: "run_cmd", input: { command: longArg } }]);
      }
      return { text: "Done", stepsCount: 1 };
    });

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ message_id: 6001 });
    const editMessageTextSpy: ReturnType<typeof vi.fn> = vi.fn()
      .mockRejectedValueOnce(new Error("Bad Request: message too long"))
      .mockResolvedValueOnce(undefined);

    const ctx: Context = makeCtx({
      chatId: 100,
      text: "test",
      replyImpl: replySpy,
    });
    (ctx as unknown as { api?: unknown }).api = {
      editMessageText: editMessageTextSpy,
    };

    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.handleMessageAsync(ctx);

    expect(editMessageTextSpy).toHaveBeenCalledTimes(2);
  }, 600000);

  it("should surface genuine edit failures as warning on primary path", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const loggerService: LoggerService = LoggerService.getInstance();
    const warnSpy = vi.spyOn(loggerService, "warn").mockClear();

    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({ text: "Done", stepsCount: 1 });

    const replySpy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ message_id: 6001 });
    const editMessageTextSpy: ReturnType<typeof vi.fn> = vi.fn()
      .mockRejectedValue(new Error("Bad Request: chat not found"));

    const ctx: Context = makeCtx({
      chatId: 100,
      text: "test",
      replyImpl: replySpy,
    });
    (ctx as unknown as { api?: unknown }).api = {
      editMessageText: editMessageTextSpy,
    };

    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.handleMessageAsync(ctx);

    expect(warnSpy).toHaveBeenCalledWith(
      "Telegram editMessageText failed",
      expect.objectContaining({ error: "Bad Request: chat not found" }),
    );
  }, 600000);

  it("should treat 'message is not modified' as noise on merged-queue path", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const loggerService: LoggerService = LoggerService.getInstance();
    const warnSpy = vi.spyOn(loggerService, "warn").mockClear();

    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({ text: "queued response", stepsCount: 1 });

    const fakeBotApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7001 }),
      editMessageText: vi.fn().mockRejectedValue(new Error("Bad Request: message is not modified")),
    };
    (handler as unknown as { _bot: unknown })._bot = { api: fakeBotApi };

    await (handler as unknown as {
      _processMergedQueuedMessageAsync: (chatId: string, queuedMessages: Array<{ text: string; messageId: number | null; imageAttachments: unknown[] }>) => Promise<void>
    })._processMergedQueuedMessageAsync("100", [
      { text: "queued message", messageId: null, imageAttachments: [] },
    ]);

    expect(fakeBotApi.editMessageText).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Telegram editMessageText failed"),
      expect.anything(),
    );
  }, 600000);

  it("should handle 'message too long' gracefully on merged-queue path (no crash)", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const handler: TelegramHandler = TelegramHandler.getInstance();

    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({ text: "queued response", stepsCount: 1 });

    const fakeBotApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7001 }),
      editMessageText: vi.fn().mockRejectedValue(new Error("Bad Request: message too long")),
    };
    (handler as unknown as { _bot: unknown })._bot = { api: fakeBotApi };

    await (handler as unknown as {
      _processMergedQueuedMessageAsync: (chatId: string, queuedMessages: Array<{ text: string; messageId: number | null; imageAttachments: unknown[] }>) => Promise<void>
    })._processMergedQueuedMessageAsync("100", [
      { text: "queued message", messageId: null, imageAttachments: [] },
    ]);

    expect(fakeBotApi.editMessageText).toHaveBeenCalled();
  }, 600000);

  it("should surface genuine edit failures as warning on merged-queue path", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const loggerService: LoggerService = LoggerService.getInstance();
    const warnSpy = vi.spyOn(loggerService, "warn").mockClear();

    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);
    vi.spyOn(mainAgent, "processMessageForChatAsync").mockResolvedValue({ text: "queued response", stepsCount: 1 });

    const fakeBotApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7001 }),
      editMessageText: vi.fn().mockRejectedValue(new Error("Bad Request: chat not found")),
    };
    (handler as unknown as { _bot: unknown })._bot = { api: fakeBotApi };

    await (handler as unknown as {
      _processMergedQueuedMessageAsync: (chatId: string, queuedMessages: Array<{ text: string; messageId: number | null; imageAttachments: unknown[] }>) => Promise<void>
    })._processMergedQueuedMessageAsync("100", [
      { text: "queued message", messageId: null, imageAttachments: [] },
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      "Telegram editMessageText failed",
      expect.objectContaining({ error: "Bad Request: chat not found" }),
    );
  }, 600000);
});

//#endregion Tests
