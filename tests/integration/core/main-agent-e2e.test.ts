import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { MainAgent, type IAgentResult } from "../../../src/agent/main-agent.js";
import type { MessageSender, PhotoSender } from "../../../src/tools/index.js";
import type { IToolCallSummary } from "../../../src/agent/base-agent.js";


let tempDir: string;
let originalHome: string;
const sentMessages: string[] = [];
const stepTraces: { stepNumber: number; toolNames: string[] }[] = [];


const mockMessageSender: MessageSender = async (message: string): Promise<string | null> => {
  sentMessages.push(message);
  return "mock-message-id";
};

const mockPhotoSender: PhotoSender = async (): Promise<string | null> => {
  return "mock-photo-id";
};


//#region Tests

describe("MainAgent E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-agent-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
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

    await vectorStoreService.initializeAsync(
      undefined,
      embeddingService.getDimension(),
    );

    const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();

    await skillLoaderService.loadAllSkillsAsync([]);

    const channelRegistry: ChannelRegistryService = ChannelRegistryService.getInstance();
    await channelRegistry.initializeAsync();
    await channelRegistry.registerChannelAsync("telegram", "test-chat", {
      permission: "full",
      receiveNotifications: false,
    });

    const mainAgent: MainAgent = MainAgent.getInstance();

    await mainAgent.initializeForChatAsync(
      "test-chat",
      mockMessageSender,
      mockPhotoSender,
      async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
        stepTraces.push({
          stepNumber,
          toolNames: toolCalls.map((tc: IToolCallSummary): string => tc.name),
        });
      },
      "telegram",
    );
  }, 300000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should process a simple message and return a result", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const result: IAgentResult = await mainAgent.processMessageForChatAsync(
      "test-chat",
      "Say exactly 'hello world' and nothing else. Then call the done tool.",
    );

  expect(result).toBeDefined();
  expect(typeof result.text).toBe("string");
  expect(result.text.length).toBeGreaterThan(0);
  expect(result.stepsCount).toBeGreaterThanOrEqual(1);
  }, 60000);

  it("should use the think tool when asked to reason", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    const result: IAgentResult = await mainAgent.processMessageForChatAsync(
      "test-chat",
      "Think about what 15 * 17 equals using the think tool first, then tell me the answer and call done.",
    );

    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("255");
  }, 60000);

  it("should create table and then use write_table tool with temp database", async () => {
    stepTraces.length = 0;

    const mainAgent: MainAgent = MainAgent.getInstance();
    const result: IAgentResult = await mainAgent.processMessageForChatAsync(
      "test-chat",
      [
        "Do exactly these steps:",
        "1) create database test_db",
        "2) create table test_users in test_db with columns: id INTEGER primary key, name TEXT not null, email TEXT, is_active INTEGER default 1",
        "3) insert one row into test_users with name 'Jane Smith', email 'jane@example.com' using write_table_test_users",
        "4) finish",
        "Do NOT use run_cmd, write_file, append_file, edit_file, or read_file.",
      ].join("\n"),
    );

    expect(result).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);

    const exists: boolean = await litesql.databaseExistsAsync("test_db");
    expect(exists).toBe(true);

    const query = await litesql.queryTableAsync("test_db", "test_users", {
      where: "email = 'jane@example.com'",
      limit: 5,
    });
    expect(query.totalCount).toBeGreaterThanOrEqual(1);

    const tableExists: boolean = await litesql.tableExistsAsync("test_db", "test_users");
    expect(tableExists).toBe(true);

    const toolNames: string[] = stepTraces.flatMap((trace) => trace.toolNames);
    expect(toolNames).toContain("write_table_test_users");
    expect(toolNames).not.toContain("run_cmd");
    expect(toolNames).not.toContain("write_file");

    const dbs = await litesql.listDatabasesAsync();
    const testDbInfo = dbs.find((d) => d.name === "test_db");
    expect(testDbInfo).toBeDefined();
    expect(testDbInfo!.path.startsWith(tempDir)).toBe(true);
  }, 180000);
});

//#endregion Tests
