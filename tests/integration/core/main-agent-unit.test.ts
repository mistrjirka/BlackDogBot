import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { MainAgent } from "../../../src/agent/main-agent.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import type { MessageSender, PhotoSender } from "../../../src/tools/index.js";


let tempDir: string;
let originalHome: string;

const TEST_CONFIG_YAML: string = `
ai:
  provider: openrouter
  openrouter:
    apiKey: test-key
    model: anthropic/claude-sonnet-4
    rateLimits:
      rpm: 60
      tpm: 100000

scheduler:
  enabled: false

knowledge:
  embeddingProvider: local
  embeddingModelPath: onnx-community/Qwen3-Embedding-0.6B-ONNX
  embeddingDtype: q8
  embeddingDevice: cpu
  embeddingOpenRouterModel: nvidia/llama-nemotron-embed-vl-1b-v2:free
  lancedbPath: ~/.blackdogbot/knowledge/lancedb

skills:
  directories: []

logging:
  level: info

services:
  searxngUrl: http://localhost:18731
  crawl4aiUrl: http://localhost:18732
`;

/**
 * Resets all singletons involved in MainAgent unit tests.
 */

/**
 * Initializes all services required by MainAgent.initializeForChatAsync
 * using real implementations (no mocks).
 */
async function initializeServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();

  await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const tempConfigPath: string = path.join(tempDir, ".blackdogbot", "config.yaml");

  await configService.initializeAsync(tempConfigPath);

  const aiProviderService: AiProviderService = AiProviderService.getInstance();

  aiProviderService.initialize(configService.getConfig().ai);

  const promptService: PromptService = PromptService.getInstance();

  await promptService.initializeAsync();
}

const messageSender: MessageSender = async (): Promise<string | null> => null;
const photoSender: PhotoSender = async (): Promise<string | null> => null;


//#region Tests

describe("MainAgent unit", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-agent-unit-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Write deterministic config fixture into the temp home directory
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.writeFile(tempConfigPath, TEST_CONFIG_YAML, "utf-8");
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

  it("should continue run after steering abort instead of returning stopped", async () => {
    await initializeServicesAsync();

    const mainAgent: MainAgent = MainAgent.getInstance();
    await mainAgent.initializeForChatAsync("chat-steer", messageSender, photoSender);

    const session = (mainAgent as unknown as {
      _sessions: Map<string, { steeringQueue: string[]; abortController: AbortController | null }>;
    })._sessions.get("chat-steer");

    expect(session).toBeDefined();

    let firstGenerateStartedResolve: (() => void) | null = null;
    const firstGenerateStarted: Promise<void> = new Promise<void>((resolve) => {
      firstGenerateStartedResolve = resolve;
    });

    let generateCallCount: number = 0;
    const fakeAgent = {
      generate: vi.fn(async (args: { abortSignal: AbortSignal; messages: Array<{ role: string; content: unknown }> }) => {
        generateCallCount++;

        if (generateCallCount === 1) {
          firstGenerateStartedResolve?.();
          await new Promise<never>((_resolve, reject) => {
            args.abortSignal.addEventListener("abort", () => {
              const abortError: Error = new Error("Operation was stopped.");
              abortError.name = "AbortError";
              reject(abortError);
            });
          });
        }

        const hasSystemSteeringMessage: boolean = args.messages.some((m) =>
          m.role === "system" &&
          ((typeof m.content === "string" && m.content.includes("[STEER]")) ||
            (Array.isArray(m.content) && JSON.stringify(m.content).includes("[STEER]"))),
        );

        expect(hasSystemSteeringMessage).toBe(false);

        const hasUserSteeringMessage: boolean = args.messages.some((m) =>
          m.role === "user" &&
          ((typeof m.content === "string" && m.content.includes("[STEER]")) ||
            (Array.isArray(m.content) && JSON.stringify(m.content).includes("[STEER]"))),
        );

        expect(hasUserSteeringMessage).toBe(true);

        return {
          text: "Steering applied and continued.",
          steps: [{ type: "text" }],
          usage: { inputTokens: 10, outputTokens: 5 },
          response: { messages: [] },
        };
      }),
    };

    (mainAgent as unknown as { _agent: unknown })._agent = fakeAgent;

    const runPromise: Promise<{ text: string; stepsCount: number }> = mainAgent.processMessageForChatAsync(
      "chat-steer",
      "start long task",
    );

    await firstGenerateStarted;

    const steerResult: boolean = mainAgent.steerChat("chat-steer", "please explain what changed");
    expect(steerResult).toBe(true);

    const result = await runPromise;

    expect(result.text).toBe("Steering applied and continued.");
    expect(result.text).not.toBe("Operation was stopped.");
    expect(generateCallCount).toBeGreaterThanOrEqual(2);
    expect(session?.steeringQueue.length).toBe(0);
  });
});

//#endregion Tests
