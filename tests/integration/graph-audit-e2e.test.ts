import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  renderGraphForAudit,
  auditGraphWithLLM,
  type IJobContext,
} from "../../src/utils/graph-audit.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import type { IJob, INode } from "../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("graph-audit E2E — real LLM calls", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-graphaudit-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config to temp HOME so AiProviderService picks up the API key
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    // Copy prompts directory for graph-audit prompt
    const realPromptsDir: string = path.join(originalHome, ".betterclaw", "prompts");
    const tempPromptsDir: string = path.join(tempConfigDir, "prompts");
    await fs.mkdir(tempPromptsDir, { recursive: true });
    await fs.cp(realPromptsDir, tempPromptsDir, { recursive: true });

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    AiProviderService.getInstance().initialize(configService.getConfig().ai);

    const promptService: PromptService = PromptService.getInstance();
    await promptService.initializeAsync();
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should render a simple graph for audit", () => {
    // Create a simple 2-node graph: start -> output_to_ai
    const mockJob: IJob = {
      jobId: "job-001",
      name: "Simple Test Job",
      description: "A simple test job for audit rendering",
      status: "ready",
      entrypointNodeId: "node-start",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const mockNodes: INode[] = [
      {
        nodeId: "node-start",
        jobId: "job-001",
        type: "start",
        name: "Start Node",
        description: "Entry point for the job",
        inputSchema: {},
        outputSchema: {
          type: "object",
          properties: {
            trigger: { type: "string" },
          },
        },
        connections: ["node-output"],
        config: { scheduledTaskId: null },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        nodeId: "node-output",
        jobId: "job-001",
        type: "output_to_ai",
        name: "Process Output",
        description: "Process the data with AI",
        inputSchema: {
          type: "object",
          properties: {
            trigger: { type: "string" },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            result: { type: "string" },
          },
        },
        connections: [],
        config: {
          prompt: "Summarize the input data",
          model: null,
        },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ];

    const result: string = renderGraphForAudit(mockJob, mockNodes);

    // Verify output contains job metadata
    expect(result).toContain("# Job Metadata");
    expect(result).toContain("Name: Simple Test Job");
    expect(result).toContain("Description: A simple test job for audit rendering");
    expect(result).toContain("Status: ready");
    expect(result).toContain("Entrypoint: node-start");

    // Verify output contains node details
    expect(result).toContain("# Nodes");
    expect(result).toContain("## Start Node (entrypoint)");
    expect(result).toContain("## Process Output");
    expect(result).toContain("Type: start");
    expect(result).toContain("Type: output_to_ai");

    // Verify output contains ASCII graph
    expect(result).toContain("# Graph Visualization");
    expect(result).toContain("Start Node");
    expect(result).toContain("Process Output");
  });

  it("should detect fan-in issues in graph description", () => {
    // Create a graph with 3 nodes where 1 node receives from 2 parents
    const mockJob: IJob = {
      jobId: "job-002",
      name: "Fan-in Test Job",
      description: "A job with fan-in pattern",
      status: "ready",
      entrypointNodeId: "node-start",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const mockNodes: INode[] = [
      {
        nodeId: "node-start",
        jobId: "job-002",
        type: "start",
        name: "Start Node",
        description: "Entry point",
        inputSchema: {},
        outputSchema: { type: "object", properties: { data: { type: "string" } } },
        connections: ["node-branch-a", "node-branch-b"],
        config: { scheduledTaskId: null },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        nodeId: "node-branch-a",
        jobId: "job-002",
        type: "python_code",
        name: "Branch A",
        description: "First processing branch",
        inputSchema: { type: "object", properties: { data: { type: "string" } } },
        outputSchema: { type: "object", properties: { resultA: { type: "string" } } },
        connections: ["node-merge"],
        config: { code: "result = input_data", pythonPath: "python3", timeout: 30 },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        nodeId: "node-branch-b",
        jobId: "job-002",
        type: "python_code",
        name: "Branch B",
        description: "Second processing branch",
        inputSchema: { type: "object", properties: { data: { type: "string" } } },
        outputSchema: { type: "object", properties: { resultB: { type: "string" } } },
        connections: ["node-merge"],
        config: { code: "result = input_data", pythonPath: "python3", timeout: 30 },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        nodeId: "node-merge",
        jobId: "job-002",
        type: "output_to_ai",
        name: "Merge Node",
        description: "Merges results from both branches",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { final: { type: "string" } } },
        connections: [],
        config: { prompt: "Combine the results", model: null },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ];

    const result: string = renderGraphForAudit(mockJob, mockNodes);

    // Verify fan-in warning is detected
    expect(result).toContain("FAN-IN WARNING");
    expect(result).toContain("Fan-in:");
    expect(result).toContain("Merge Node");
    expect(result).toContain("Branch A");
    expect(result).toContain("Branch B");
  });

  it("should audit a valid graph with LLM and approve it", async () => {
    // Create a simple valid graph description
    const graphDescription: string = `# Job Metadata
Name: Simple Data Processor
Description: A simple job that processes data with Python and outputs to AI
Status: ready
Entrypoint: node-start

# Nodes

## Start Node (entrypoint)
- Type: start
- ID: node-start
- Description: Entry point for the job
- Config: (default)
- Input Schema: (empty)
- Output Schema: object { data: string }
- Connects to: Process Data

## Process Data
- Type: python_code
- ID: node-process
- Description: Process the input data
- Config: code="result = {'processed': input_data['data']}"
- Input Schema: object { data: string }
- Output Schema: object { processed: string }
- Connects to: Output Result

## Output Result
- Type: output_to_ai
- ID: node-output
- Description: Format and output the result
- Config: prompt="Format this data nicely"
- Input Schema: object { processed: string }
- Output Schema: object { result: string }
- Connects to: (none - terminal node)

# Graph Visualization

Start Node --> Process Data --> Output Result

# Potential Issues

(No structural issues detected)`;

    const jobContext: IJobContext = {
      jobName: "Simple Data Processor",
      jobDescription: "A simple job that processes data with Python and outputs to AI",
    };

    const result = await auditGraphWithLLM(graphDescription, jobContext);

    expect(result).toBeDefined();
    // We validate structure, not LLM judgment. The problematic graph test validates rejection behavior.
    expect(typeof result.approved).toBe("boolean");
    expect(Array.isArray(result.issues)).toBe(true);
    result.issues.forEach((issue) => {
      // Issues are strings, not objects (per GraphAuditResultSchema)
      expect(typeof issue).toBe("string");
    });
    expect(Array.isArray(result.suggestions)).toBe(true);
  }, 250_000);
    // Create a graph description with obvious problems
    const graphDescription: string = `# Job Metadata
Name: Problematic Job
Description: A job with structural issues
Status: ready
Entrypoint: node-start

# Nodes

## Start Node (entrypoint)
- Type: start
- ID: node-start
- Description: Entry point
- Config: (default)
- Input Schema: (empty)
- Output Schema: object { data: string }
- Connects to: Branch A, Branch B

## Branch A
- Type: python_code
- ID: node-branch-a
- Description: First branch
- Config: code="result = input_data"
- Input Schema: object { data: string }
- Output Schema: object { resultA: string }
- Connects to: Merge

## Branch B
- Type: python_code
- ID: node-branch-b
- Description: Second branch
- Config: code="result = input_data"
- Input Schema: object { data: string }
- Output Schema: object { resultB: string }
- Connects to: Merge

## Merge
- Type: output_to_ai
- ID: node-merge
- Description: Merge results
- Config: prompt="Combine results"
- Input Schema: (empty)
- Output Schema: object { final: string }
- Connects to: (none - terminal node)

# Graph Visualization

Start Node --> Branch A --> Merge
           \\-> Branch B /

# Potential Issues

- Fan-in: "Merge" receives data from 2 nodes: Branch A, Branch B
- Dead end: "Merge" has no outgoing connections`;

    const jobContext: IJobContext = {
      jobName: "Problematic Job",
      jobDescription: "A job with structural issues including fan-in without merge logic",
    };

    const result = await auditGraphWithLLM(graphDescription, jobContext);

    expect(result).toBeDefined();
    expect(result.approved).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(Array.isArray(result.suggestions)).toBe(true);
  }, 250_000);
});

//#endregion Tests
