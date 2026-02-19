import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../src/services/logger.service.js";
import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { JobStorageService } from "../../src/services/job-storage.service.js";
import { JobExecutorService } from "../../src/services/job-executor.service.js";
import type { IJob, INode } from "../../src/shared/types/index.js";

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
    const servicesSection: string = `\nservices:\n  searxngUrl: http://localhost:18731\n  crawl4aiUrl: http://localhost:18732\n`;

    await writeConfigAsync(configPath, realConfigContent + servicesSection);

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
      "manual",
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
      job.jobId, "manual", "Node A", "First node", schema, schema, {},
    );

    const nodeB: INode = await storageService.addNodeAsync(
      job.jobId, "manual", "Node B", "Second node", schema, schema, {},
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
      job.jobId, "manual", "Input Node", "Passes input through",
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
      job.jobId, "manual", "Strict Node", "Requires a number",
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
        extracted: {},
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
    expect(output.extracted).toBeDefined();
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
        reasoningEffort: null,
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
      job.jobId, "manual", "Input Node", "Passes input through",
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
      "manual",
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
      "manual",
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
