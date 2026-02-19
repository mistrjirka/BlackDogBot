import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { MainAgent } from "../../src/agent/main-agent.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { MessagingService } from "../../src/services/messaging.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { PromptService } from "../../src/services/prompt.service.js";

//#region Helpers

/**
 * Resets all singletons involved in MainAgent unit tests.
 */
function resetSingletons(): void {
  (MainAgent as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (MessagingService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("MainAgent unit", () => {
  beforeEach(() => {
    resetSingletons();

    // Silence logger
    const logger: LoggerService = LoggerService.getInstance();
    (logger as unknown as { _initialized: boolean })._initialized = true;
    (logger as unknown as { info: unknown }).info = vi.fn();
    (logger as unknown as { warn: unknown }).warn = vi.fn();
    (logger as unknown as { error: unknown }).error = vi.fn();
    (logger as unknown as { debug: unknown }).debug = vi.fn();
  });

  afterEach(() => {
    resetSingletons();
    vi.restoreAllMocks();
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
    // Arrange — stub initializeForChatAsync so we don't need a real LLM stack
    const mainAgent: MainAgent = MainAgent.getInstance();

    vi.spyOn(mainAgent, "initializeForChatAsync").mockImplementation(
      async (chatId: string) => {
        // Manually create the session the way the real implementation does
        const sessions = (
          mainAgent as unknown as { _sessions: Map<string, unknown> }
        )._sessions;

        if (!sessions.has(chatId)) {
          sessions.set(chatId, { messages: [], lastActivityAt: Date.now() });
        }
      },
    );

    // Create a session for chat-1
    await mainAgent.initializeForChatAsync("chat-1", async () => null);

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
    // Arrange
    const mainAgent: MainAgent = MainAgent.getInstance();

    vi.spyOn(mainAgent, "initializeForChatAsync").mockImplementation(
      async (chatId: string) => {
        const sessions = (
          mainAgent as unknown as { _sessions: Map<string, unknown> }
        )._sessions;

        if (!sessions.has(chatId)) {
          sessions.set(chatId, { messages: [], lastActivityAt: Date.now() });
        }
      },
    );

    await mainAgent.initializeForChatAsync("chat-1", async () => null);
    await mainAgent.initializeForChatAsync("chat-2", async () => null);

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
    // Arrange
    const mainAgent: MainAgent = MainAgent.getInstance();

    // Stub _buildAgent to avoid needing a full AI stack
    vi.spyOn(
      mainAgent as unknown as { _buildAgent: () => void },
      "_buildAgent",
    ).mockReturnValue(undefined);

    // Stub AiProviderService and PromptService
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    vi.spyOn(aiProviderService, "getModel").mockReturnValue(
      {} as import("ai").LanguageModel,
    );

    const promptService: PromptService = PromptService.getInstance();
    vi.spyOn(
      promptService as unknown as { getPromptAsync: (key: string) => Promise<string> },
      "getPromptAsync",
    ).mockResolvedValue("system prompt");

    // Act — call initializeForChatAsync twice for the same chatId
    await mainAgent.initializeForChatAsync("chat-1", async () => null);
    await mainAgent.initializeForChatAsync("chat-1", async () => null);

    const sessions = (
      mainAgent as unknown as { _sessions: Map<string, unknown> }
    )._sessions;

    // Assert — still only one session entry
    expect(sessions.size).toBe(1);
  });
});

//#endregion Tests
