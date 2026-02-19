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
import { SkillStateService } from "../../src/services/skill-state.service.js";
import { RssStateService } from "../../src/services/rss-state.service.js";
import { MainAgent, type IAgentResult } from "../../src/agent/main-agent.js";
import type { IJob, INode } from "../../src/shared/types/index.js";
import type { MessageSender, PhotoSender } from "../../src/tools/index.js";

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
  (JobStorageService as unknown as { _instance: null })._instance = null;
  (JobExecutorService as unknown as { _instance: null })._instance = null;
  (SkillLoaderService as unknown as { _instance: null })._instance = null;
  (SkillStateService as unknown as { _instance: null })._instance = null;
  (RssStateService as unknown as { _instance: null })._instance = null;
  (MainAgent as unknown as { _instance: null })._instance = null;
}

const mockMessageSender: MessageSender = async (message: string): Promise<string | null> => {
  sentMessages.push(message);
  return "mock-message-id";
};

const mockPhotoSender: PhotoSender = async (): Promise<string | null> => {
  return "mock-photo-id";
};

//#endregion Helpers

//#region Tests

describe("AI Job Pipeline E2E — RSS + Agent", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-pipeline-e2e-"));
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

    // Initialize all services
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

    const mainAgent: MainAgent = MainAgent.getInstance();

    await mainAgent.initializeForChatAsync("test-chat", mockMessageSender, mockPhotoSender);
  }, 120_000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should create, test, finish, and run an RSS + agent job end-to-end", async () => {
    const mainAgent: MainAgent = MainAgent.getInstance();

    const prompt: string = `Create a job called "HN Headlines Digest" with description "Fetches the latest Hacker News headlines via RSS and uses an agent to summarize them."

The job should have exactly two nodes wired in a pipeline:

1. RSS Fetcher node named "HN Feed":
   - type: rss_fetcher
   - config: url "https://news.ycombinator.com/rss", maxItems 2, mode "latest"
   - inputSchema: empty object {}
   - outputSchema: { "type": "object", "properties": { "items": { "type": "array" }, "totalItems": { "type": "number" } }, "required": ["items", "totalItems"] }

2. Agent node named "Headline Summarizer":
   - type: agent
   - config: systemPrompt "You receive RSS feed data. Extract only the titles from the items array and return them as a JSON array of strings. Call the done tool with { \"result\": { \"titles\": [\"title1\", \"title2\"] } }.", selectedTools ["think"], model null, reasoningEffort null, maxSteps 5
   - inputSchema: { "type": "object", "properties": { "items": { "type": "array" }, "totalItems": { "type": "number" } }, "required": ["items", "totalItems"] }
   - outputSchema: { "type": "object", "properties": { "titles": { "type": "array", "items": { "type": "string" } } }, "required": ["titles"] }

Wire them: HN Feed -> Headline Summarizer. Set HN Feed as entrypoint.

Then for each node, add a test case and run it:
- For "HN Feed": add a test named "fetch test" with inputData {} and run the test.
- For "Headline Summarizer": add a test named "summarize test" with inputData { "items": [{ "title": "Test Article", "link": "https://example.com" }], "totalItems": 1 } and run the test.

After all tests pass, call finish_job to mark the job ready.
Then run the full job with run_job using input {}.
Then call done.`;

    const result: IAgentResult = await mainAgent.processMessageForChatAsync("test-chat", prompt);

    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);

    // Verify the job was created, finished, and run
    const storageService: JobStorageService = JobStorageService.getInstance();
    const jobs: IJob[] = await storageService.listJobsAsync();

    const digestJob: IJob | undefined = jobs.find(
      (j: IJob) => j.name.toLowerCase().includes("hn") || j.name.toLowerCase().includes("headline"),
    );

    expect(digestJob).toBeDefined();

    // After run_job, the status should be back to "ready" (run_job sets to running then completed or back to ready)
    // The key point is it should NOT be "creating" — finish_job + run_job should have moved it forward
    expect(digestJob!.status).not.toBe("creating");

    // Verify nodes exist
    const nodes: INode[] = await storageService.listNodesAsync(digestJob!.jobId);

    expect(nodes.length).toBe(2);

    const rssNode: INode | undefined = nodes.find((n: INode) => n.type === "rss_fetcher");
    const agentNode: INode | undefined = nodes.find((n: INode) => n.type === "agent");

    expect(rssNode).toBeDefined();
    expect(agentNode).toBeDefined();

    // Verify the pipeline is wired: rss -> agent
    expect(rssNode!.connections).toContain(agentNode!.nodeId);

    // Verify entrypoint is the RSS node
    expect(digestJob!.entrypointNodeId).toBe(rssNode!.nodeId);
  }, 300_000);
});

//#endregion Tests
