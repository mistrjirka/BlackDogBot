import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { JobExecutorService } from "../../../src/services/job-executor.service.js";
import { RssStateService } from "../../../src/services/rss-state.service.js";
import { LiteSqlService } from "../../../src/services/litesql.service.js";
import type { IJob, INode, IJobExecutionResult } from "../../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
  (JobExecutorService as unknown as { _instance: null })._instance = null;
  (RssStateService as unknown as { _instance: null })._instance = null;
  (LiteSqlService as unknown as { _instance: null })._instance = null;
}

async function writeConfigAsync(configPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, "utf-8");
}

//#endregion Helpers

//#region Tests

describe("Job Execution E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-job-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config and append Docker service URLs
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const configPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });

    const realConfigContent: string = await fs.readFile(realConfigPath, "utf-8");
    
    let configWithServices: string = realConfigContent;
    
    if (!realConfigContent.includes("services:")) {
      const servicesSection: string = `\nservices:\n  searxngUrl: http://localhost:18731\n  crawl4aiUrl: http://localhost:18732\n`;
      configWithServices = realConfigContent + servicesSection;
    }

    await writeConfigAsync(configPath, configWithServices);

    // Initialize all required services
    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();

    await configService.initializeAsync(configPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();

    aiProviderService.initialize(configService.getAiConfig());
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  //#region Manual & Python Node Tests

  it("should execute a single manual node job (passthrough)", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Single Manual Node Job",
      "A job with one manual passthrough node",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "start",
      "Passthrough Node",
      "Passes input to output",
      inputSchema,
      outputSchema,
      {},
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { message: "Hello from E2E test!" });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);
    expect(result.output).toEqual({ message: "Hello from E2E test!" });
  });

  it("should execute a chain of two manual nodes", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Two Node Chain",
      "A job with two manual nodes in a chain",
    );

    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        value: { type: "number" },
      },
      required: ["value"],
    };

    const nodeA: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Node A", "First node", schema, schema, {},
    );

    const nodeB: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Node B", "Second node", schema, schema, {},
    );

    await storageService.updateNodeAsync(job.jobId, nodeA.nodeId, {
      connections: [nodeB.nodeId],
    });

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: nodeA.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { value: 42 });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(2);
    expect(result.output).toEqual({ value: 42 });
  });

  it("should execute a python_code node that transforms data", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Python Transform Job",
      "A job with a python node that doubles a number",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { number: { type: "number" } },
      required: ["number"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        number: { type: "number" },
        doubled: { type: "number" },
      },
      required: ["number", "doubled"],
    };

    const pythonCode: string = [
      "result = {'number': input_data['number'], 'doubled': input_data['number'] * 2}",
      "import json",
      "print(json.dumps(result))",
    ].join("\n");

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "python_code",
      "Doubler Node",
      "Doubles the input number",
      inputSchema,
      outputSchema,
      {
        code: pythonCode,
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { number: 21 });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.number).toBe(21);
    expect(output.doubled).toBe(42);
  });

  it("should execute a mixed manual + python pipeline", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Mixed Pipeline Job",
      "Manual node feeds into Python node",
    );

    const manualSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["x", "y"],
    };

    const pythonOutputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        sum: { type: "number" },
        product: { type: "number" },
      },
      required: ["x", "y", "sum", "product"],
    };

    const manualNode: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Input Node", "Passes input through",
      manualSchema, manualSchema, {},
    );

    const pythonCode: string = [
      "result = {",
      "    'x': input_data['x'],",
      "    'y': input_data['y'],",
      "    'sum': input_data['x'] + input_data['y'],",
      "    'product': input_data['x'] * input_data['y']",
      "}",
      "import json",
      "print(json.dumps(result))",
    ].join("\n");

    const pythonNode: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Calculator Node", "Computes sum and product",
      manualSchema, pythonOutputSchema,
      {
        code: pythonCode,
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    await storageService.updateNodeAsync(job.jobId, manualNode.nodeId, {
      connections: [pythonNode.nodeId],
    });

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: manualNode.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { x: 6, y: 7 });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(2);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.x).toBe(6);
    expect(output.y).toBe(7);
    expect(output.sum).toBe(13);
    expect(output.product).toBe(42);
  });

  it("should fail with validation error when input does not match schema", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Validation Fail Job",
      "Should fail on input validation",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Strict Node", "Requires a number",
      inputSchema, inputSchema, {},
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { count: "not-a-number" });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.toLowerCase()).toContain("validation");
  });

  it("should fail when python code produces invalid output", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Bad Python Output Job",
      "Python produces wrong schema output",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    };

    const pythonCode: string = [
      "import json",
      "print(json.dumps({'wrong_key': 123}))",
    ].join("\n");

    const node: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Bad Output Node", "Produces wrong schema",
      inputSchema, outputSchema,
      {
        code: pythonCode,
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { value: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.toLowerCase()).toContain("validation");
  });

  //#endregion Manual & Python Node Tests

  //#region curl_fetcher Node Tests

  it("should execute a curl_fetcher node with GET request", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Curl Fetcher GET Job",
      "Fetches data from httpbin via curl_fetcher",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        statusCode: { type: "number" },
        headers: { type: "object" },
        body: {},
      },
      required: ["statusCode", "headers", "body"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "curl_fetcher",
      "HTTP GET Node",
      "Fetches httpbin /get endpoint",
      inputSchema,
      outputSchema,
      {
        url: "https://httpbin.org/get",
        method: "GET",
        headers: { "Accept": "application/json" },
        body: null,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.statusCode).toBe(200);
    expect(output.headers).toBeDefined();
    expect(output.body).toBeDefined();
  }, 30000);

  it("should execute a curl_fetcher node with template substitution", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Curl Fetcher Template Job",
      "Uses template substitution in URL from input",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        code: { type: "number" },
      },
      required: ["code"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        statusCode: { type: "number" },
        headers: { type: "object" },
        body: {},
      },
      required: ["statusCode", "headers", "body"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "curl_fetcher",
      "Status Code Node",
      "Fetches httpbin /status/{{code}}",
      inputSchema,
      outputSchema,
      {
        url: "https://httpbin.org/status/{{code}}",
        method: "GET",
        headers: {},
        body: null,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { code: 200 });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.statusCode).toBe(200);
  }, 30000);

  //#endregion curl_fetcher Node Tests

  //#region searxng Node Tests

  it("should execute a searxng node to search the web", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "SearXNG Search Job",
      "Searches the web via local SearXNG instance",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        query: { type: "string" },
        results: { type: "array" },
        totalResults: { type: "number" },
      },
      required: ["query", "results", "totalResults"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "searxng",
      "Web Search Node",
      "Searches for TypeScript documentation",
      inputSchema,
      outputSchema,
      {
        query: "TypeScript documentation",
        categories: ["general"],
        maxResults: 5,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.query).toBe("TypeScript documentation");
    expect(Array.isArray(output.results)).toBe(true);
    expect(typeof output.totalResults).toBe("number");
  }, 30000);

  it("should execute a searxng node with template query from input", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "SearXNG Template Job",
      "Searches with query from input via template",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        topic: { type: "string" },
      },
      required: ["topic"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        query: { type: "string" },
        results: { type: "array" },
        totalResults: { type: "number" },
      },
      required: ["query", "results", "totalResults"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "searxng",
      "Dynamic Search Node",
      "Searches with template query",
      inputSchema,
      outputSchema,
      {
        query: "{{topic}} programming language",
        categories: ["general"],
        maxResults: 3,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { topic: "Rust" });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.query).toBe("Rust programming language");
    expect(Array.isArray(output.results)).toBe(true);
  }, 30000);

  //#endregion searxng Node Tests

  //#region rss_fetcher Node Tests

  it("should execute an rss_fetcher node and return feed items", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "RSS Fetch Job",
      "Fetches an RSS feed",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        link: { type: "string" },
        items: { type: "array" },
        totalItems: { type: "number" },
        feedUrl: { type: "string" },
      },
      required: ["title", "items", "feedUrl"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "rss_fetcher",
      "RSS Feed Node",
      "Fetches Hacker News RSS feed",
      inputSchema,
      outputSchema,
      {
        url: "https://news.ycombinator.com/rss",
        maxItems: 5,
        mode: "latest",
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.title).toBeDefined();
    expect(output.description).toBeDefined();
    expect(output.link).toBeDefined();
    expect(Array.isArray(output.items)).toBe(true);
    expect((output.items as unknown[]).length).toBeLessThanOrEqual(5);
    expect(output.totalItems).toBeDefined();
    expect(output.feedUrl).toBe("https://news.ycombinator.com/rss");
  }, 30000);

  it("should execute an rss_fetcher node with template substitution", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "RSS Template Job",
      "Fetches RSS with dynamic URL",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        feedUrl: { type: "string" },
      },
      required: ["feedUrl"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        items: { type: "array" },
        feedUrl: { type: "string" },
      },
      required: ["items", "feedUrl"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "rss_fetcher",
      "Dynamic RSS Node",
      "Fetches RSS with template URL",
      inputSchema,
      outputSchema,
      {
        url: "{{feedUrl}}",
        maxItems: 3,
        mode: "latest",
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {
      feedUrl: "https://news.ycombinator.com/rss",
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect((output.items as unknown[]).length).toBeLessThanOrEqual(3);
    expect(output.feedUrl).toBe("https://news.ycombinator.com/rss");
  }, 30000);

  it("should return mode field in output for latest mode", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync("RSS Mode Field Job", "");
    const inputSchema: Record<string, unknown> = { type: "object", properties: {} };
    const outputSchema: Record<string, unknown> = { type: "object", properties: { items: { type: "array" }, mode: { type: "string" } }, required: ["items", "mode"] };

    const node: INode = await storageService.addNodeAsync(
      job.jobId, "rss_fetcher", "RSS Node", "",
      inputSchema, outputSchema,
      { url: "https://itsfoss.com/feed", maxItems: 3, mode: "latest" },
    );

    await storageService.updateJobAsync(job.jobId, { entrypointNodeId: node.nodeId, status: "ready" });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.mode).toBe("latest");
    expect(Array.isArray(output.items)).toBe(true);
    expect((output.items as unknown[]).length).toBeLessThanOrEqual(3);
    expect(output.unseenCount).toBeUndefined();
  }, 30000);

  it("should parse an Atom feed (The Verge) and return items", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync("Atom Feed Job", "Parses an Atom feed");
    const inputSchema: Record<string, unknown> = { type: "object", properties: {} };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        title: { type: "string" },
        items: { type: "array" },
        feedUrl: { type: "string" },
        mode: { type: "string" },
      },
      required: ["items", "feedUrl"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId, "rss_fetcher", "Atom Node", "The Verge Atom feed",
      inputSchema, outputSchema,
      { url: "https://www.theverge.com/rss/index.xml", maxItems: 5, mode: "latest" },
    );

    await storageService.updateJobAsync(job.jobId, { entrypointNodeId: node.nodeId, status: "ready" });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(Array.isArray(output.items)).toBe(true);
    expect((output.items as unknown[]).length).toBeGreaterThan(0);
    expect((output.items as unknown[]).length).toBeLessThanOrEqual(5);
    expect(output.mode).toBe("latest");

    // Each entry should have an id (Atom) and a link
    const firstItem: Record<string, unknown> = (output.items as Record<string, unknown>[])[0];

    expect(firstItem.id ?? firstItem.link).toBeDefined();
  }, 30000);

  it("should execute unseen mode: first fetch returns items, second fetch returns empty", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();
    const rssStateService: RssStateService = RssStateService.getInstance();

    const feedUrl: string = "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml";

    // Ensure no leftover state from a previous run
    const stateFilePath: string = (await import("../../src/utils/paths.js")).getRssStateFilePath(feedUrl);

    try {
      await fs.rm(stateFilePath);
    } catch {
      // File may not exist, that's fine
    }

    // --- First fetch ---
    const job1: IJob = await storageService.createJobAsync("RSS Unseen First Fetch", "");
    const schema: Record<string, unknown> = { type: "object", properties: {} };

    const node1: INode = await storageService.addNodeAsync(
      job1.jobId, "rss_fetcher", "RSS Node", "",
      schema, schema,
      { url: feedUrl, maxItems: 50, mode: "unseen" },
    );

    await storageService.updateJobAsync(job1.jobId, { entrypointNodeId: node1.nodeId, status: "ready" });

    const result1 = await executorService.executeJobAsync(job1.jobId, {});

    expect(result1.success).toBe(true);

    const output1: Record<string, unknown> = result1.output as Record<string, unknown>;

    expect(output1.mode).toBe("unseen");
    expect(typeof output1.unseenCount).toBe("number");
    expect(Array.isArray(output1.items)).toBe(true);
    // First fetch with no prior state — items should be the feed items
    expect((output1.items as unknown[]).length).toBeGreaterThan(0);

    // State file must have been created
    const state = await rssStateService.loadStateAsync(feedUrl);

    expect(state).not.toBeNull();
    expect(state!.seenIds.length).toBeGreaterThan(0);
    expect(state!.feedUrl).toBe(feedUrl);

    // --- Second fetch ---
    const job2: IJob = await storageService.createJobAsync("RSS Unseen Second Fetch", "");

    const node2: INode = await storageService.addNodeAsync(
      job2.jobId, "rss_fetcher", "RSS Node", "",
      schema, schema,
      { url: feedUrl, maxItems: 50, mode: "unseen" },
    );

    await storageService.updateJobAsync(job2.jobId, { entrypointNodeId: node2.nodeId, status: "ready" });

    const result2 = await executorService.executeJobAsync(job2.jobId, {});

    expect(result2.success).toBe(true);

    const output2: Record<string, unknown> = result2.output as Record<string, unknown>;

    expect(output2.mode).toBe("unseen");
    // Second fetch with all items already seen — should return zero items
    expect((output2.items as unknown[]).length).toBe(0);
    expect(output2.unseenCount).toBe(0);

    // Cleanup
    try {
      await fs.rm(stateFilePath);
    } catch {
      // ignore
    }
  }, 60000);

  it("should unseen mode: maxItems caps returned items even when more are unseen", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();
    const rssStateService: RssStateService = RssStateService.getInstance();

    const feedUrl: string = "https://itsfoss.com/feed";

    // Ensure clean state
    const stateFilePath: string = (await import("../../src/utils/paths.js")).getRssStateFilePath(feedUrl);

    try {
      await fs.rm(stateFilePath);
    } catch {
      // File may not exist
    }

    const job: IJob = await storageService.createJobAsync("RSS Unseen Cap Job", "");
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    const cap: number = 2;

    const node: INode = await storageService.addNodeAsync(
      job.jobId, "rss_fetcher", "RSS Node", "",
      schema, schema,
      { url: feedUrl, maxItems: cap, mode: "unseen" },
    );

    await storageService.updateJobAsync(job.jobId, { entrypointNodeId: node.nodeId, status: "ready" });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    // Returned items must be <= cap
    expect((output.items as unknown[]).length).toBeLessThanOrEqual(cap);

    // unseenCount is total unseen before the cap was applied
    expect(typeof output.unseenCount).toBe("number");

    // All items in the feed must have been marked as seen (not just the capped ones)
    const state = await rssStateService.loadStateAsync(feedUrl);

    expect(state).not.toBeNull();
    expect(state!.seenIds.length).toBeGreaterThanOrEqual(output.totalItems as number);

    // Cleanup
    try {
      await fs.rm(stateFilePath);
    } catch {
      // ignore
    }
  }, 30000);

  //#endregion rss_fetcher Node Tests

  //#region crawl4ai Node Tests

  it("should execute a crawl4ai node to crawl a webpage", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Crawl4AI Crawl Job",
      "Crawls a webpage via local Crawl4AI instance",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        url: { type: "string" },
        success: { type: "boolean" },
        markdown: { type: "string" },
        html: { type: "string" },
      },
      required: ["url", "success", "markdown", "html"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "crawl4ai",
      "Web Crawler Node",
      "Crawls example.com",
      inputSchema,
      outputSchema,
      {
        url: "https://example.com",
        extractionPrompt: null,
        selector: null,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.url).toBe("https://example.com");
    expect(output.success).toBe(true);
    expect(typeof output.markdown).toBe("string");
    expect((output.markdown as string).length).toBeGreaterThan(0);
    expect(typeof output.html).toBe("string");
  }, 60000);

  it("should execute a crawl4ai node with extraction prompt", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Crawl4AI Extraction Job",
      "Crawls and extracts structured data via AI",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        url: { type: "string" },
        success: { type: "boolean" },
        markdown: { type: "string" },
        html: { type: "string" },
        extracted: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      },
      required: ["url", "success", "markdown", "html"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "crawl4ai",
      "AI Extractor Node",
      "Crawls example.com and extracts the page title via AI",
      inputSchema,
      outputSchema,
      {
        url: "https://example.com",
        extractionPrompt: "Extract the page title from this content. Respond with JSON: {\"title\": \"the title\"}",
        selector: null,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.url).toBe("https://example.com");
    expect(output.success).toBe(true);
    expect(typeof output.extracted).toBe("object");
    expect(output.extracted).toHaveProperty("title");
    expect(typeof (output.extracted as Record<string, unknown>).title).toBe("string");
  }, 120000);

  //#endregion crawl4ai Node Tests

  //#region output_to_ai Node Tests

  it("should execute an output_to_ai node that transforms data via LLM", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Output to AI Job",
      "Sends data to LLM for transformation",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        wordCount: { type: "number" },
        language: { type: "string" },
      },
      required: ["wordCount", "language"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "output_to_ai",
      "Text Analyzer Node",
      "Analyzes text via LLM",
      inputSchema,
      outputSchema,
      {
        prompt: "Analyze the given text. Count the number of words and detect the language. Respond ONLY with valid JSON in this exact format: {\"wordCount\": <number>, \"language\": \"<language name>\"}. No other text.",
        model: null,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {
      text: "Hello world, this is a test sentence with exactly ten words here.",
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(typeof output.wordCount).toBe("number");
    expect(typeof output.language).toBe("string");
    expect((output.language as string).toLowerCase()).toContain("english");
  }, 120000);

  //#endregion output_to_ai Node Tests

  //#region agent Node Tests

  it("should execute an agent node that completes a simple task", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Agent Node Job",
      "An agent node that processes input and returns structured output",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          items: { type: "number" },
        },
      },
      required: ["numbers"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        sum: { type: "number" },
        average: { type: "number" },
        count: { type: "number" },
      },
      required: ["sum", "average", "count"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "agent",
      "Math Agent Node",
      "An agent that calculates statistics from numbers",
      inputSchema,
      outputSchema,
      {
        systemPrompt: "You are a math assistant. Given an array of numbers, calculate the sum, average, and count. When done, call the done tool with a JSON object containing sum (number), average (number), and count (number).",
        selectedTools: ["think"],
        model: null,
        reasoningEffort: "low",
        maxSteps: 5,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {
      numbers: [10, 20, 30, 40, 50],
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(output.sum).toBe(150);
    expect(output.average).toBe(30);
    expect(output.count).toBe(5);
  }, 120000);

  it("should execute an agent node with file tools (read_file, write_file) in selectedTools", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Agent File Tools Job",
      "An agent node that uses file tools to write and read a file",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        content: { type: "string" },
      },
      required: ["content"],
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        written: { type: "boolean" },
        readBack: { type: "string" },
      },
      required: ["written", "readBack"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "agent",
      "File IO Agent",
      "Writes a file and reads it back",
      inputSchema,
      outputSchema,
      {
        systemPrompt: [
          "You have file tools available. Your task:",
          "1. Use write_file to write the input content to a file named 'agent-test-output.txt'.",
          "2. Use read_file to read 'agent-test-output.txt' back.",
          "3. Call the done tool with { \"result\": { \"written\": true, \"readBack\": \"<the content you read>\" } }.",
        ].join("\n"),
        selectedTools: ["read_file", "write_file"],
        model: null,
        reasoningEffort: "low",
        maxSteps: 10,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result: IJobExecutionResult = await executorService.executeJobAsync(job.jobId, {
      content: "hello from agent file tools test",
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;
    expect(output.written).toBe(true);
    expect(typeof output.readBack).toBe("string");
    expect((output.readBack as string)).toContain("hello from agent file tools test");
  }, 120000);

  //#endregion agent Node Tests

  //#region Pipeline Tests with New Node Types

  it("should execute a pipeline: manual -> python -> output_to_ai", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Mixed Pipeline with AI Job",
      "Manual input feeds Python which feeds AI summarizer",
    );

    // Node 1: manual passthrough
    const manualSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    };

    const manualNode: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Input Node", "Passes input through",
      manualSchema, manualSchema, {},
    );

    // Node 2: Python that computes several values
    const pythonOutputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
        sum: { type: "number" },
        difference: { type: "number" },
        product: { type: "number" },
      },
      required: ["a", "b", "sum", "difference", "product"],
    };

    const pythonCode: string = [
      "result = {",
      "    'a': input_data['a'],",
      "    'b': input_data['b'],",
      "    'sum': input_data['a'] + input_data['b'],",
      "    'difference': input_data['a'] - input_data['b'],",
      "    'product': input_data['a'] * input_data['b']",
      "}",
      "import json",
      "print(json.dumps(result))",
    ].join("\n");

    const pythonNode: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Calculator", "Computes math operations",
      manualSchema, pythonOutputSchema,
      {
        code: pythonCode,
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Node 3: AI summarizer that describes the math results
    const aiOutputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
    };

    const aiNode: INode = await storageService.addNodeAsync(
      job.jobId, "output_to_ai", "Summarizer", "Summarizes the math results",
      pythonOutputSchema, aiOutputSchema,
      {
        prompt: "You are given math computation results. Create a one-sentence summary describing all the results. Respond ONLY with valid JSON: {\"summary\": \"<your summary>\"}. No other text.",
        model: null,
      },
    );

    // Connect: manual -> python -> ai
    await storageService.updateNodeAsync(job.jobId, manualNode.nodeId, {
      connections: [pythonNode.nodeId],
    });
    await storageService.updateNodeAsync(job.jobId, pythonNode.nodeId, {
      connections: [aiNode.nodeId],
    });

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: manualNode.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { a: 15, b: 3 });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(3);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    expect(typeof output.summary).toBe("string");
    expect((output.summary as string).length).toBeGreaterThan(0);
  }, 120000);

  //#endregion Pipeline Tests with New Node Types

  //#region Fan-out & Fan-in Tests

  it("should fan-out: both branches receive same parent output", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Fan-out Job",
      "Start node fans out to two python nodes",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };

    const startNode: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Start", "Passes value through",
      inputSchema, inputSchema, {},
    );

    // Branch A: doubles the value
    const branchA: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Doubler", "Doubles the value",
      inputSchema,
      { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"] },
      {
        code: "import json\nprint(json.dumps({'doubled': input_data['value'] * 2}))",
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Branch B: squares the value
    const branchB: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Squarer", "Squares the value",
      inputSchema,
      { type: "object", properties: { squared: { type: "number" } }, required: ["squared"] },
      {
        code: "import json\nprint(json.dumps({'squared': input_data['value'] ** 2}))",
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Start fans out to both branches
    await storageService.updateNodeAsync(job.jobId, startNode.nodeId, {
      connections: [branchA.nodeId, branchB.nodeId],
    });

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: startNode.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { value: 5 });

    expect(result.success).toBe(true);
    expect(result.nodesExecuted).toBe(3);
    // Last node in topological order gets its output as result
    // Both branches run — the result is the last branch's output
    expect(result.output).toBeDefined();
  });

  it("should fan-in: downstream node receives merged output from multiple parents", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Fan-in Diamond Job",
      "Diamond graph: Start → [A, B] → Merge",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };

    const startNode: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Start", "Passes value",
      inputSchema, inputSchema, {},
    );

    // Branch A: outputs { doubled: value*2 }
    const branchA: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Doubler", "Doubles",
      {},
      { type: "object", properties: { doubled: { type: "number" } } },
      {
        code: "import json\nprint(json.dumps({'doubled': input_data['value'] * 2}))",
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Branch B: outputs { squared: value^2 }
    const branchB: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Squarer", "Squares",
      {},
      { type: "object", properties: { squared: { type: "number" } } },
      {
        code: "import json\nprint(json.dumps({'squared': input_data['value'] ** 2}))",
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Merge node: receives { doubled, squared } from fan-in merge
    const mergeNode: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "Merger", "Combines doubled and squared",
      {},
      { type: "object", properties: { sum_of_both: { type: "number" } } },
      {
        code: "import json\nprint(json.dumps({'sum_of_both': input_data['doubled'] + input_data['squared']}))",
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Wire up diamond: Start → [A, B], A → Merge, B → Merge
    await storageService.updateNodeAsync(job.jobId, startNode.nodeId, {
      connections: [branchA.nodeId, branchB.nodeId],
    });
    await storageService.updateNodeAsync(job.jobId, branchA.nodeId, {
      connections: [mergeNode.nodeId],
    });
    await storageService.updateNodeAsync(job.jobId, branchB.nodeId, {
      connections: [mergeNode.nodeId],
    });

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: startNode.nodeId,
      status: "ready",
    });

    // value=5: doubled=10, squared=25, sum_of_both=35
    const result = await executorService.executeJobAsync(job.jobId, { value: 5 });

    expect(result.success).toBe(true);
    expect(result.nodesExecuted).toBe(4);

    const output = result.output as Record<string, unknown>;
    expect(output.sum_of_both).toBe(35);
  });

  it("should fan-in: later parent overwrites duplicate keys from earlier parent", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Fan-in Overwrite Job",
      "Two parents output same key — later one wins",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };

    const startNode: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Start", "Passes value",
      inputSchema, inputSchema, {},
    );

    // Branch A: outputs { result: "from_a" }
    const branchA: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "A", "Outputs from_a",
      {},
      { type: "object", properties: { result: { type: "string" } } },
      {
        code: 'import json\nprint(json.dumps({"result": "from_a"}))',
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Branch B: outputs { result: "from_b" }
    const branchB: INode = await storageService.addNodeAsync(
      job.jobId, "python_code", "B", "Outputs from_b",
      {},
      { type: "object", properties: { result: { type: "string" } } },
      {
        code: 'import json\nprint(json.dumps({"result": "from_b"}))',
        pythonPath: "python3",
        timeout: 10000,
      },
    );

    // Merge: passthrough start node to just read the merged input
    const mergeNode: INode = await storageService.addNodeAsync(
      job.jobId, "start", "Merge", "Passthrough",
      {}, {}, {},
    );

    // Start → [A, B], A → Merge, B → Merge
    await storageService.updateNodeAsync(job.jobId, startNode.nodeId, {
      connections: [branchA.nodeId, branchB.nodeId],
    });
    await storageService.updateNodeAsync(job.jobId, branchA.nodeId, {
      connections: [mergeNode.nodeId],
    });
    await storageService.updateNodeAsync(job.jobId, branchB.nodeId, {
      connections: [mergeNode.nodeId],
    });

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: startNode.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { value: 1 });

    expect(result.success).toBe(true);

    const output = result.output as Record<string, unknown>;
    // Shallow-merge means last parent in iteration order overwrites
    // Both outputs have "result" key — one of them wins (order depends on node iteration)
    expect(output.result).toMatch(/^from_(a|b)$/);
  });

  //#endregion Fan-out & Fan-in Tests

  //#region Error Reporting Tests

  it("should report failedNodeId and failedNodeName when curl_fetcher gets a 404", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Curl 404 Error Job",
      "A curl_fetcher that hits a 404 endpoint",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        statusCode: { type: "number" },
      },
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "curl_fetcher",
      "NotFound Fetcher",
      "Fetches a 404 endpoint",
      inputSchema,
      outputSchema,
      {
        url: "https://httpbin.org/status/404",
        method: "GET",
        headers: {},
        body: null,
      },
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
    expect(result.error).toContain("NotFound Fetcher");
    expect(result.failedNodeId).toBe(node.nodeId);
    expect(result.failedNodeName).toBe("NotFound Fetcher");
    expect(result.nodesExecuted).toBe(0);
  }, 30000);

  it("should count nodesExecuted correctly when second node in pipeline fails", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Second Node Failure Job",
      "First node succeeds, second node fails with 500",
    );

    const emptySchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };

    const nodeA: INode = await storageService.addNodeAsync(
      job.jobId,
      "start",
      "Passthrough Entry",
      "Passes input through",
      emptySchema,
      emptySchema,
      {},
    );

    const nodeB: INode = await storageService.addNodeAsync(
      job.jobId,
      "curl_fetcher",
      "Failing Fetcher",
      "Fetches a 500 endpoint",
      emptySchema,
      emptySchema,
      {
        url: "https://httpbin.org/status/500",
        method: "GET",
        headers: {},
        body: null,
      },
    );

    await storageService.updateNodeAsync(job.jobId, nodeA.nodeId, {
      connections: [nodeB.nodeId],
    });

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: nodeA.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, {});

    expect(result.success).toBe(false);
    expect(result.nodesExecuted).toBe(1);
    expect(result.failedNodeId).toBe(nodeB.nodeId);
    expect(result.failedNodeName).toBe("Failing Fetcher");
    expect(result.error).toContain("500");
  }, 30000);

  it("should set failedNodeId and failedNodeName to null on success", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const job: IJob = await storageService.createJobAsync(
      "Success No Failure Info Job",
      "A simple successful job should have null failure fields",
    );

    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "start",
      "Simple Node",
      "A simple passthrough node",
      schema,
      schema,
      {},
    );

    await storageService.updateJobAsync(job.jobId, {
      entrypointNodeId: node.nodeId,
      status: "ready",
    });

    const result = await executorService.executeJobAsync(job.jobId, { value: "test" });

    expect(result.success).toBe(true);
    expect(result.failedNodeId).toBeNull();
    expect(result.failedNodeName).toBeNull();
  });

  //#endregion Error Reporting Tests
});

//#endregion Tests
