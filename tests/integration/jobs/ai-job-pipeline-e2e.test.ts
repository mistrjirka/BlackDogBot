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
import * as skillState from "../../../src/helpers/skill-state.js";
import * as rssState from "../../../src/helpers/rss-state.js";
import * as litesql from "../../../src/helpers/litesql.js";
import { MainAgent, type IAgentResult } from "../../../src/agent/main-agent.js";
import type {
  IJob,
  INode,
  IJobExecutionResult,
  INodeTestCase,
  INodeTestResult,
  IRssFetcherConfig,
  IAgentNodeConfig,
} from "../../../src/shared/types/index.js";
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

function buildAsciiGraph(nodes: INode[], entrypointNodeId: string | null): string {
  const nodeMap: Map<string, INode> = new Map<string, INode>();

  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  const formatNode = (node: INode): string => `${node.name} [${node.type}] (${node.nodeId})`;
  const lines: string[] = [];

  lines.push(`Entrypoint: ${entrypointNodeId ?? "<none>"}`);
  lines.push(`Nodes: ${nodes.length}`);
  lines.push("");
  lines.push("Adjacency:");

  for (const node of nodes) {
    if (node.connections.length === 0) {
      lines.push(`  ${formatNode(node)} -> (no outgoing edges)`);
      continue;
    }

    for (const targetId of node.connections) {
      const target: INode | undefined = nodeMap.get(targetId);
      lines.push(`  ${formatNode(node)} -> ${target ? formatNode(target) : `${targetId} [missing]`}`);
    }
  }

  lines.push("");
  lines.push("Reachability from entrypoint:");

  if (!entrypointNodeId || !nodeMap.has(entrypointNodeId)) {
    lines.push("  (entrypoint missing or invalid)");
    return lines.join("\n");
  }

  const visited: Set<string> = new Set<string>();

  const walk = (nodeId: string, prefix: string): void => {
    const node: INode | undefined = nodeMap.get(nodeId);

    if (!node) {
      lines.push(`${prefix}└─ ${nodeId} [missing]`);
      return;
    }

    const marker: string = visited.has(nodeId) ? " (already visited)" : "";
    lines.push(`${prefix}└─ ${formatNode(node)}${marker}`);

    if (visited.has(nodeId)) {
      return;
    }

    visited.add(nodeId);

    for (const childId of node.connections) {
      walk(childId, `${prefix}   `);
    }
  };

  walk(entrypointNodeId, "");

  const unreachable: INode[] = nodes.filter((n: INode) => !visited.has(n.nodeId));

  if (unreachable.length > 0) {
    lines.push("");
    lines.push("Unreachable nodes:");
    for (const node of unreachable) {
      lines.push(`  - ${formatNode(node)}`);
    }
  }

  return lines.join("\n");
}


//#region Tests

describe("AI Job Pipeline E2E — RSS + Agent", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-pipeline-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();
    sentMessages.length = 0;

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
    const lanceDbPath: string = path.join(tempDir, ".betterclaw", "knowledge", "lancedb");

    await vectorStoreService.initializeAsync(
      lanceDbPath,
      embeddingService.getDimension(),
    );

    const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();

    await skillLoaderService.loadAllSkillsAsync([]);

    const mainAgent: MainAgent = MainAgent.getInstance();

    await mainAgent.initializeForChatAsync("test-chat", mockMessageSender, mockPhotoSender);
  }, 300_000);

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

    console.log("\n========== AGENT RESPONSE ==========");
    console.log("Steps count:", result.stepsCount);
    console.log("Agent text:", result.text);
    console.log("====================================\n");

    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);

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

    const nodes: INode[] = await storageService.listNodesAsync(digestJob!.jobId);

    const startNode: INode | undefined = nodes.find((n: INode) => n.type === "start");
    const rssNode: INode | undefined = nodes.find((n: INode) => n.type === "rss_fetcher");
    const agentNode: INode | undefined = nodes.find((n: INode) => n.type === "agent");

    console.log("\n========== ASCII GRAPH ==========");
    console.log(buildAsciiGraph(nodes, digestJob!.entrypointNodeId));
    console.log("=================================\n");

    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(rssNode).toBeDefined();
    expect(agentNode).toBeDefined();

    const rssConfig: IRssFetcherConfig = rssNode!.config as IRssFetcherConfig;
    const agentConfig: IAgentNodeConfig = agentNode!.config as IAgentNodeConfig;

    if (startNode) {
      console.log("\n========== START NODE ==========");
      console.log("Node ID:", startNode.nodeId);
      console.log("Name:", startNode.name);
      console.log("Type:", startNode.type);
      console.log("Connections (outgoing):", JSON.stringify(startNode.connections));
      console.log("================================\n");
    }

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

    if (startNode) {
      expect(startNode.connections).toContain(rssNode!.nodeId);
      expect(digestJob!.entrypointNodeId).toBe(startNode.nodeId);
    } else {
      expect(digestJob!.entrypointNodeId).toBe(rssNode!.nodeId);
    }

    expect(rssNode!.connections).toContain(agentNode!.nodeId);
    expect(agentNode!.connections).toEqual([]);

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

    await storageService.updateJobAsync(digestJob!.jobId, { status: "ready" });

    const pipelineResult: IJobExecutionResult = await executorService.executeJobAsync(digestJob!.jobId, {});

    console.log("\n========== FULL PIPELINE EXECUTION ==========");
    console.log("Success:", pipelineResult.success);
    console.log("Nodes executed:", pipelineResult.nodesExecuted);
    console.log("Error:", pipelineResult.error);
    console.log("Failed node ID:", pipelineResult.failedNodeId);
    console.log("Failed node name:", pipelineResult.failedNodeName);
    console.log("Pipeline output:", JSON.stringify(pipelineResult.output, null, 2));
    console.log("\nPipeline graph snapshot:\n" + buildAsciiGraph(nodes, digestJob!.entrypointNodeId));
    console.log("==============================================\n");

    expect(pipelineResult.success).toBe(true);
    expect(pipelineResult.nodesExecuted).toBeGreaterThanOrEqual(2);
    expect(pipelineResult.nodesExecuted).toBeLessThanOrEqual(3);
    expect(pipelineResult.output).toBeDefined();

    const pipelineOutput: Record<string, unknown> = pipelineResult.output as Record<string, unknown>;

    expect(pipelineOutput).toHaveProperty("titles");
    expect(Array.isArray(pipelineOutput.titles)).toBe(true);
    expect((pipelineOutput.titles as string[]).length).toBeGreaterThanOrEqual(1);

    for (const title of pipelineOutput.titles as string[]) {
      expect(typeof title).toBe("string");
      expect(title.length).toBeGreaterThan(0);
    }

    console.log("\n========== SENT MESSAGES ==========");
    console.log("Total messages sent:", sentMessages.length);
    for (let i: number = 0; i < sentMessages.length; i++) {
      console.log(`  [${i}]: ${sentMessages[i]}`);
    }
    console.log("====================================\n");
  }, 300_000);
});

//#endregion Tests
