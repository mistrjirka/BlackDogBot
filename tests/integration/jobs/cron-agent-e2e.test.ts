import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { EmbeddingService } from "../../../src/services/embedding.service.js";
import { VectorStoreService } from "../../../src/services/vector-store.service.js";
import { KnowledgeService } from "../../../src/services/knowledge.service.js";
import { CronAgent } from "../../../src/agent/cron-agent.js";
import type { IAgentResult } from "../../../src/agent/base-agent.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";
import type { MessageSender } from "../../../src/tools/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;
const sentMessages: string[] = [];

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
  (EmbeddingService as unknown as { _instance: null })._instance = null;
  (VectorStoreService as unknown as { _instance: null })._instance = null;
  (KnowledgeService as unknown as { _instance: null })._instance = null;
  (CronAgent as unknown as { _instance: null })._instance = null;
}

const mockMessageSender: MessageSender = async (message: string): Promise<string | null> => {
  sentMessages.push(message);
  return "mock-message-id";
};

//#endregion Helpers

//#region Tests

describe("CronAgent E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-cron-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();
    sentMessages.length = 0;

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
    const lanceDbPath: string = path.join(tempDir, ".betterclaw", "knowledge", "lancedb");

    await vectorStoreService.initializeAsync(
      lanceDbPath,
      embeddingService.getDimension(),
    );
  }, 300000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should execute a scheduled task using the think tool and return a result", async () => {
    const cronAgent: CronAgent = CronAgent.getInstance();

    const task: IScheduledTask = {
      taskId: "test-cron-task-001",
      name: "E2E Test Task",
      description: "A simple test task for E2E testing",
      instructions: "Think about the number 42 using the think tool, then call done with a summary mentioning the number 42.",
      tools: ["think"],
      schedule: { type: "once", runAt: new Date().toISOString() },
      notifyUser: false,
      enabled: true,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result: IAgentResult = await cronAgent.executeTaskAsync(task, mockMessageSender);

    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain('42');
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
  }, 60000);

  it("should execute a task that uses the send_message tool", async () => {
    const cronAgent: CronAgent = CronAgent.getInstance();
    sentMessages.length = 0;

    const task: IScheduledTask = {
      taskId: "test-cron-task-002",
      name: "Message Sending Task",
      description: "A task that sends a message",
      instructions: "Send a message to the user saying 'Hello from cron!' using the send_message tool, then call done.",
      tools: ["send_message"],
      schedule: { type: "once", runAt: new Date().toISOString() },
      notifyUser: false,
      enabled: true,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result: IAgentResult = await cronAgent.executeTaskAsync(task, mockMessageSender);

    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
    // The agent should have called send_message, which triggered our mock
    expect(sentMessages.length).toBeGreaterThan(0);
    // At least one message should contain something about "hello" or "cron"
    const anyMessageMatchesCron: boolean = sentMessages.some(
      (msg: string) => msg.toLowerCase().includes("hello") || msg.toLowerCase().includes("cron"),
    );

    expect(anyMessageMatchesCron).toBe(true);
  }, 60000);
});

//#endregion Tests
