import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { MainAgent } from "../../src/agent/main-agent.js";
import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import type { MessageSender, PhotoSender } from "../../src/tools/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

/**
 * Resets all singletons involved in MainAgent unit tests.
 */
function resetSingletons(): void {
  (MainAgent as unknown as { _instance: null })._instance = null;
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
}

/**
 * Initializes all services required by MainAgent.initializeForChatAsync
 * using real implementations (no mocks).
 */
async function initializeServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();

  await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const tempConfigPath: string = path.join(tempDir, ".betterclaw", "config.yaml");

  await configService.initializeAsync(tempConfigPath);

  const aiProviderService: AiProviderService = AiProviderService.getInstance();

  aiProviderService.initialize(configService.getConfig().ai);

  const promptService: PromptService = PromptService.getInstance();

  await promptService.initializeAsync();
}

const messageSender: MessageSender = async (): Promise<string | null> => null;
const photoSender: PhotoSender = async (): Promise<string | null> => null;

//#endregion Helpers

//#region Tests

describe("MainAgent unit", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-agent-unit-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config into the temp home directory
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should throw when processMessageForChatAsync is called before initializeForChatAsync", async () => {
    // Arrange — fresh MainAgent, never initialized
    const mainAgent: MainAgent = MainAgent.getInstance();

    // Act + Assert — _ensureInitialized should throw
    await expect(
      mainAgent.processMessageForChatAsync("chat-1", "hello"),
    ).rejects.toThrow(/not initialized/i);
  });

  it("should clear chat history and allow reinitialisation for the same chatId", async () => {
    // Arrange — initialize services and MainAgent with real implementations
    await initializeServicesAsync();

    const mainAgent: MainAgent = MainAgent.getInstance();

    await mainAgent.initializeForChatAsync("chat-1", messageSender, photoSender);

    const sessions = (
      mainAgent as unknown as { _sessions: Map<string, unknown> }
    )._sessions;

    expect(sessions.has("chat-1")).toBe(true);

    // Act — clear the chat
    mainAgent.clearChatHistory("chat-1");

    // Assert — session was removed
    expect(sessions.has("chat-1")).toBe(false);
  });

  it("should keep sessions for other chats when clearing one", async () => {
    // Arrange — initialize services and create two chat sessions
    await initializeServicesAsync();

    const mainAgent: MainAgent = MainAgent.getInstance();

    await mainAgent.initializeForChatAsync("chat-1", messageSender, photoSender);
    await mainAgent.initializeForChatAsync("chat-2", messageSender, photoSender);

    const sessions = (
      mainAgent as unknown as { _sessions: Map<string, unknown> }
    )._sessions;

    expect(sessions.size).toBe(2);

    // Act — clear only chat-1
    mainAgent.clearChatHistory("chat-1");

    // Assert — chat-2 is still present
    expect(sessions.has("chat-1")).toBe(false);
    expect(sessions.has("chat-2")).toBe(true);
  });

  it("should not create a duplicate session when initializeForChatAsync is called twice for the same chat", async () => {
    // Arrange — initialize services and call initializeForChatAsync twice
    await initializeServicesAsync();

    const mainAgent: MainAgent = MainAgent.getInstance();

    await mainAgent.initializeForChatAsync("chat-1", messageSender, photoSender);
    await mainAgent.initializeForChatAsync("chat-1", messageSender, photoSender);

    const sessions = (
      mainAgent as unknown as { _sessions: Map<string, unknown> }
    )._sessions;

    // Assert — still only one session entry
    expect(sessions.size).toBe(1);
  });
});

//#endregion Tests
