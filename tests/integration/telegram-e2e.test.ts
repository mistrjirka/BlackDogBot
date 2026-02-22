import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
import { MessagingService, TelegramAdapter } from "../../src/services/messaging.service.js";
import { MainAgent, type IAgentResult } from "../../src/agent/main-agent.js";
import { TelegramHandler } from "../../src/telegram/handler.js";
import type { MessageSender } from "../../src/tools/index.js";

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

//#endregion Helpers

//#region Tests

describe("Telegram E2E", () => {
  const sentReplies: Array<{ chatId: string; text: string }> = [];

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-tg-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    // Initialize services
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
  }, 120000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should process a message through TelegramHandler with a mocked grammY context", async () => {
    // We test the TelegramHandler.handleMessageAsync method directly
    // by creating a fake grammY Context object with minimal interface
    const telegramHandler: TelegramHandler = TelegramHandler.getInstance();

    // Create a mock grammY Context — we only need the subset that TelegramHandler uses:
    // ctx.message?.text, ctx.chat?.id, ctx.from?.id, ctx.from?.first_name, ctx.message?.message_id, ctx.reply
    const replyTexts: string[] = [];

    const mockCtx: Record<string, unknown> = {
      message: {
        text: "Say 'test passed' and nothing else.",
        message_id: 12345,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 99999, type: "private" },
        from: { id: 11111, is_bot: false, first_name: "TestUser" },
      },
      chat: { id: 99999, type: "private" },
      from: { id: 11111, is_bot: false, first_name: "TestUser" },
      reply: async (text: string): Promise<{ message_id: number }> => {
        replyTexts.push(text);
        return { message_id: 99999 };
      },
    };

    // The TelegramHandler relies on MessagingService + MainAgent
    // We need to register a mock adapter so createSenderForChat works
    const messagingService: MessagingService = MessagingService.getInstance();
    const mockSentMessages: Array<{ text: string; userId: string }> = [];

    messagingService.registerAdapter({
      platform: "telegram" as const,
      sendMessageAsync: async (message) => {
        mockSentMessages.push({ text: message.text, userId: message.userId });
        return "mock-msg-id";
      },
      sendPhotoAsync: async () => {
        return "mock-photo-id";
      },
      sendChatActionAsync: async () => {},
    });

    // Call handleMessageAsync — this goes through the full pipeline:
    // TelegramHandler -> MainAgent.initializeForChatAsync -> MainAgent.processMessageForChatAsync -> reply
    await telegramHandler.handleMessageAsync(mockCtx as never);

    // The handler should have replied to the context
    expect(replyTexts.length).toBeGreaterThan(0);
    // The reply should contain something (the agent's response)
    expect(replyTexts[0].length).toBeGreaterThan(0);
  }, 120000);
});

//#endregion Tests
