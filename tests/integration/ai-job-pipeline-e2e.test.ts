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
import { LiteSqlService } from "../../src/services/litesql.service.js";
import { MainAgent, type IAgentResult } from "../../src/agent/main-agent.js";
import type {
  IJob,
  INode,
  IJobExecutionResult,
  INodeTestCase,
  INodeTestResult,
  IRssFetcherConfig,
  IAgentNodeConfig,
} from "../../src/shared/types/index.js";
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
  (LiteSqlService as unknown as { _instance: null })._instance = null;
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

    // ── Agent response ──
    console.log("\n========== AGENT RESPONSE ==========");
    console.log("Steps count:", result.stepsCount);
    console.log("Agent text:", result.text);
    console.log("====================================\n");

    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);

    // ── Job inspection ──
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();
    const jobs: IJob[] = await storageService.listJobsAsync();

    const digestJob: IJob | undefined = jobs.find(
      (j: IJob) => j.name.toLowerCase().includes("hn") || j.name.toLowerCase().includes("headline"),
    );

    expect(digestJob).toBeDefined();

    console.log("\n========== JOB STATE ==========");
    console.log("Job ID:", digestJob!.jobId);
    console.log("Job name:", digestJob!.name);
    console.log("Job description:", digestJob!.description);
    console.log("Job status:", digestJob!.status);
    console.log("Entrypoint node ID:", digestJob!.entrypointNodeId);
    console.log("================================\n");

    expect(digestJob!.status).not.toBe("creating");

    // ── Node inspection ──
    const nodes: INode[] = await storageService.listNodesAsync(digestJob!.jobId);

    expect(nodes.length).toBe(3);

    const startNode: INode | undefined = nodes.find((n: INode) => n.type === "start");
    const rssNode: INode | undefined = nodes.find((n: INode) => n.type === "rss_fetcher");
    const agentNode: INode | undefined = nodes.find((n: INode) => n.type === "agent");

    expect(startNode).toBeDefined();
    expect(rssNode).toBeDefined();
    expect(agentNode).toBeDefined();

    const rssConfig: IRssFetcherConfig = rssNode!.config as IRssFetcherConfig;
    const agentConfig: IAgentNodeConfig = agentNode!.config as IAgentNodeConfig;

    console.log("\n========== START NODE ==========");
    console.log("Node ID:", startNode!.nodeId);
    console.log("Name:", startNode!.name);
    console.log("Type:", startNode!.type);
    console.log("Connections (outgoing):", JSON.stringify(startNode!.connections));
    console.log("================================\n");

    console.log("\n========== RSS NODE ==========");
    console.log("Node ID:", rssNode!.nodeId);
    console.log("Name:", rssNode!.name);
    console.log("Type:", rssNode!.type);
    console.log("Connections (outgoing):", JSON.stringify(rssNode!.connections));
    console.log("Input schema:", JSON.stringify(rssNode!.inputSchema));
    console.log("Output schema:", JSON.stringify(rssNode!.outputSchema));
    console.log("Config URL:", rssConfig.url);
    console.log("Config maxItems:", rssConfig.maxItems);
    console.log("Config mode:", rssConfig.mode);
    console.log("===============================\n");

    console.log("\n========== AGENT NODE ==========");
    console.log("Node ID:", agentNode!.nodeId);
    console.log("Name:", agentNode!.name);
    console.log("Type:", agentNode!.type);
    console.log("Connections (outgoing):", JSON.stringify(agentNode!.connections));
    console.log("Input schema:", JSON.stringify(agentNode!.inputSchema));
    console.log("Output schema:", JSON.stringify(agentNode!.outputSchema));
    console.log("Config systemPrompt:", agentConfig.systemPrompt);
    console.log("Config selectedTools:", JSON.stringify(agentConfig.selectedTools));
    console.log("Config model:", agentConfig.model);
    console.log("Config maxSteps:", agentConfig.maxSteps);
    console.log("================================\n");

    // ── Graph wiring assertions ──
    expect(startNode!.connections).toContain(rssNode!.nodeId);
    expect(rssNode!.connections).toContain(agentNode!.nodeId);
    expect(agentNode!.connections).toEqual([]);
    expect(digestJob!.entrypointNodeId).toBe(startNode!.nodeId);

    // ── Test case inspection ──
    const rssTestCases: INodeTestCase[] = await storageService.getTestCasesAsync(digestJob!.jobId, rssNode!.nodeId);
    const agentTestCases: INodeTestCase[] = await storageService.getTestCasesAsync(digestJob!.jobId, agentNode!.nodeId);

    console.log("\n========== TEST CASES ==========");
    console.log("RSS node test cases:", rssTestCases.length);
    for (const tc of rssTestCases) {
      console.log(`  - "${tc.name}" inputData:`, JSON.stringify(tc.inputData));
    }
    console.log("Agent node test cases:", agentTestCases.length);
    for (const tc of agentTestCases) {
      console.log(`  - "${tc.name}" inputData:`, JSON.stringify(tc.inputData));
    }
    console.log("================================\n");

    expect(rssTestCases.length).toBeGreaterThanOrEqual(1);
    expect(agentTestCases.length).toBeGreaterThanOrEqual(1);

    // ── Re-run node tests to see actual outputs ──
    const rssTestResults: { results: INodeTestResult[]; allPassed: boolean } =
      await executorService.runNodeTestsAsync(digestJob!.jobId, rssNode!.nodeId);

    console.log("\n========== RSS NODE TEST RESULTS ==========");
    console.log("All passed:", rssTestResults.allPassed);
    for (const tr of rssTestResults.results) {
      console.log(`  Test ${tr.testId}: passed=${tr.passed}, time=${tr.executionTimeMs}ms`);
      console.log("    Output:", JSON.stringify(tr.output, null, 2));
      if (tr.error) console.log("    Error:", tr.error);
      if (tr.validationErrors.length > 0) console.log("    Validation errors:", tr.validationErrors);
    }
    console.log("============================================\n");

    expect(rssTestResults.allPassed).toBe(true);

    const agentTestResults: { results: INodeTestResult[]; allPassed: boolean } =
      await executorService.runNodeTestsAsync(digestJob!.jobId, agentNode!.nodeId);

    console.log("\n========== AGENT NODE TEST RESULTS ==========");
    console.log("All passed:", agentTestResults.allPassed);
    for (const tr of agentTestResults.results) {
      console.log(`  Test ${tr.testId}: passed=${tr.passed}, time=${tr.executionTimeMs}ms`);
      console.log("    Output:", JSON.stringify(tr.output, null, 2));
      if (tr.error) console.log("    Error:", tr.error);
      if (tr.validationErrors.length > 0) console.log("    Validation errors:", tr.validationErrors);
    }
    console.log("==============================================\n");

    expect(agentTestResults.allPassed).toBe(true);

    // ── Re-run full pipeline to see end-to-end output ──
    // Reset status back to ready since the AI's run_job left it as "completed"
    await storageService.updateJobAsync(digestJob!.jobId, { status: "ready" });

    const pipelineResult: IJobExecutionResult = await executorService.executeJobAsync(digestJob!.jobId, {});

    console.log("\n========== FULL PIPELINE EXECUTION ==========");
    console.log("Success:", pipelineResult.success);
    console.log("Nodes executed:", pipelineResult.nodesExecuted);
    console.log("Error:", pipelineResult.error);
    console.log("Failed node ID:", pipelineResult.failedNodeId);
    console.log("Failed node name:", pipelineResult.failedNodeName);
    console.log("Pipeline output:", JSON.stringify(pipelineResult.output, null, 2));
    console.log("==============================================\n");

    expect(pipelineResult.success).toBe(true);
    expect(pipelineResult.nodesExecuted).toBe(3);
    expect(pipelineResult.output).toBeDefined();

    // The agent node should have produced titles
    const pipelineOutput: Record<string, unknown> = pipelineResult.output as Record<string, unknown>;

    expect(pipelineOutput).toHaveProperty("titles");
    expect(Array.isArray(pipelineOutput.titles)).toBe(true);
    expect((pipelineOutput.titles as string[]).length).toBeGreaterThanOrEqual(1);

    // Each title should be a non-empty string
    for (const title of pipelineOutput.titles as string[]) {
      expect(typeof title).toBe("string");
      expect(title.length).toBeGreaterThan(0);
    }

    // ── Messages sent via mockMessageSender ──
    console.log("\n========== SENT MESSAGES ==========");
    console.log("Total messages sent:", sentMessages.length);
    for (let i: number = 0; i < sentMessages.length; i++) {
      console.log(`  [${i}]: ${sentMessages[i]}`);
    }
    console.log("====================================\n");
  }, 300_000);
});

//#endregion Tests
