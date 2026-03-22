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
import { MainAgent, type IAgentResult } from "../../../src/agent/main-agent.js";
import type { IJob } from "../../../src/shared/types/index.js";
import type { MessageSender, PhotoSender } from "../../../src/tools/index.js";


let tempDir: string;
let originalHome: string;
const sentMessages: string[] = [];


const mockMessageSender: MessageSender = async (message: string): Promise<string | null> => {
  sentMessages.push(message);
  return "mock-message-id";
};

const mockPhotoSender: PhotoSender = async (): Promise<string | null> => {
  return "mock-photo-id";
};


//#region Tests

describe("AI-Driven Job Creation E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-aijob-e2e-"));
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

    const mainAgent: MainAgent = MainAgent.getInstance();

    await mainAgent.initializeForChatAsync("test-chat", mockMessageSender, mockPhotoSender);
  }, 300000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should create a job when asked by the user", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();

    const result: IAgentResult = await mainAgent.processMessageForChatAsync(
      "test-chat",
      "Create a new job called 'Text Uppercaser' with description 'Converts text to uppercase'. Use start_job_creation, then add_job, do not add any nodes, then call done.",
    );

    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);

    const storageService: JobStorageService = JobStorageService.getInstance();
    const jobs: IJob[] = await storageService.listJobsAsync();

    expect(
      jobs.length,
      `No jobs created. stepsCount=${result.stepsCount}, agentText=${JSON.stringify(result.text)}`,
    ).toBeGreaterThanOrEqual(1);

    const createdJob: IJob | undefined = jobs.find(
      (j: IJob) => j.name.toLowerCase().includes("uppercaser") || j.name.toLowerCase().includes("uppercase"),
    );

    expect(createdJob).toBeDefined();
    expect(createdJob!.status).toBe("creating");
  }, 300000);
});

//#endregion Tests
