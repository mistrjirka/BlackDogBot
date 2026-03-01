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
import { PromptService } from "../../../src/services/prompt.service.js";
import type { IJob, INode } from "../../../src/shared/types/index.js";
import { createOutputZodSchema } from "../../../src/utils/json-schema-to-zod.js";
import { createCreateOutputSchemaTool } from "../../../src/tools/create-output-schema.tool.js";

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
  (PromptService as unknown as { _instance: null })._instance = null;
}

async function writeConfigAsync(configPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, "utf-8");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execTool<T>(toolObj: any, args: unknown): Promise<T> {
  const result = await toolObj.execute(
    args,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );

  return result as T;
}

//#endregion Helpers

//#region Tests

describe("Dynamic schema generation and agent node execution (e2e)", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-dynamic-schema-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config to temp HOME
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const configPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });

    const realConfigContent: string = await fs.readFile(realConfigPath, "utf-8");
    await writeConfigAsync(configPath, realConfigContent);

    // Create jobs directory
    await fs.mkdir(path.join(tempConfigDir, "jobs"), { recursive: true });

    // Initialize services
    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(configPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getAiConfig());

    const promptService: PromptService = PromptService.getInstance();
    await promptService.initializeAsync();
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should generate a schema dynamically, create an agent node, and execute it with valid output", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    // ── Step 1: Generate schema dynamically using create_output_schema tool ──
    console.log("\n========== STEP 1: GENERATE DYNAMIC SCHEMA ==========");

    const schemaDescription: string = `An object with:
      - sentiment: a string indicating sentiment (positive, negative, or neutral)
      - confidence: a number between 0 and 1
      - keywords: an array of important keywords from the text`;

    const schemaTool = createCreateOutputSchemaTool();
    const schemaResult = await execTool<{ success: boolean; schema: Record<string, unknown> | null; error?: string }>(
      schemaTool,
      { description: schemaDescription },
    );

    expect(schemaResult.success).toBe(true);
    const dynamicOutputSchema: Record<string, unknown> = schemaResult.schema as Record<string, unknown>;
    console.log("Generated schema:", JSON.stringify(dynamicOutputSchema, null, 2));

    // Verify the schema was generated correctly
    expect(dynamicOutputSchema.type).toBe("object");
    expect(dynamicOutputSchema.properties).toBeDefined();

    const properties = dynamicOutputSchema.properties as Record<string, unknown>;
    expect(properties.sentiment).toBeDefined();
    expect(properties.confidence).toBeDefined();
    expect(properties.keywords).toBeDefined();

    console.log("=====================================================\n");

    // ── Step 2: Create job and agent node with the dynamically generated schema ──
    console.log("========== STEP 2: CREATE AGENT NODE WITH DYNAMIC SCHEMA ==========");

    const job: IJob = await storageService.createJobAsync(
      "Dynamic Schema Agent Test",
      "An agent node that uses a dynamically generated output schema",
    );

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to analyze" },
      },
      required: ["text"],
    };

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "agent",
      "Sentiment Analyzer",
      "An agent that analyzes text sentiment and extracts keywords",
      inputSchema,
      dynamicOutputSchema,
      {
        systemPrompt: `You are a sentiment analysis expert. Given text, analyze its sentiment and extract keywords.

        You MUST call the 'done' tool with a JSON object containing:
        - sentiment: one of "positive", "negative", or "neutral"
        - confidence: a number between 0 and 1 indicating your confidence
        - keywords: an array of important keywords from the text

        Example for "I love this product!":
        { "sentiment": "positive", "confidence": 0.95, "keywords": ["love", "product"] }`,
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

    console.log("Created agent node:", node.nodeId);
    console.log("Node output schema:", JSON.stringify(node.outputSchema, null, 2));
    console.log("====================================================================\n");

    // ── Step 3: Verify the Zod schema can be created from the dynamic schema ──
    console.log("========== STEP 3: VERIFY ZOD SCHEMA CONVERSION ==========");

    const zodSchema = createOutputZodSchema(node.outputSchema);
    console.log("Zod schema created successfully");

    // Test the Zod schema with sample data
    const sampleOutput = {
      sentiment: "positive",
      confidence: 0.9,
      keywords: ["test", "sample"],
    };

    const parseResult = zodSchema.safeParse(sampleOutput);
    expect(parseResult.success).toBe(true);
    console.log("Sample output validation: PASSED");
    console.log("=========================================================\n");

    // ── Step 4: Execute the agent node ──
    console.log("========== STEP 4: EXECUTE AGENT NODE ==========");

    const testInput = {
      text: "I absolutely love this new phone! The camera quality is amazing and the battery lasts forever. Best purchase I've made this year!",
    };

    console.log("Input:", JSON.stringify(testInput, null, 2));

    const result = await executorService.executeJobAsync(job.jobId, testInput);

    console.log("Execution success:", result.success);
    console.log("Nodes executed:", result.nodesExecuted);
    console.log("Error:", result.error);
    console.log("Output:", JSON.stringify(result.output, null, 2));
    console.log("================================================\n");

    // ── Step 5: Validate the output against the dynamic schema ──
    console.log("========== STEP 5: VALIDATE OUTPUT AGAINST DYNAMIC SCHEMA ==========");

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.nodesExecuted).toBe(1);

    const output: Record<string, unknown> = result.output as Record<string, unknown>;

    // Validate using the Zod schema
    const outputValidation = zodSchema.safeParse(output);
    expect(outputValidation.success).toBe(true);

    if (!outputValidation.success) {
      console.log("Validation errors:", JSON.stringify(outputValidation.error.issues, null, 2));
    }

    // Verify specific fields
    expect(output).toHaveProperty("sentiment");
    expect(output).toHaveProperty("confidence");
    expect(output).toHaveProperty("keywords");

    // Validate sentiment is one of the expected values
    expect(["positive", "negative", "neutral"]).toContain(output.sentiment);

    // Validate confidence is a number between 0 and 1
    expect(typeof output.confidence).toBe("number");
    expect(output.confidence).toBeGreaterThanOrEqual(0);
    expect(output.confidence).toBeLessThanOrEqual(1);

    // Validate keywords is an array of strings
    expect(Array.isArray(output.keywords)).toBe(true);
    for (const keyword of output.keywords as unknown[]) {
      expect(typeof keyword).toBe("string");
    }

    console.log("Output validation: PASSED");
    console.log("Sentiment:", output.sentiment);
    console.log("Confidence:", output.confidence);
    console.log("Keywords:", output.keywords);
    console.log("====================================================================\n");

    // ── Summary ──
    console.log("========== SUMMARY ==========");
    console.log("✓ Schema generated dynamically");
    console.log("✓ Agent node created with dynamic schema");
    console.log("✓ Zod schema created from JSON Schema");
    console.log("✓ Agent node executed successfully");
    console.log("✓ Output validated against dynamic schema");
    console.log("==============================\n");
  }, 180000);

  it("should handle blueprint-compatible schema and validate output", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    const schemaTool = createCreateOutputSchemaTool();
    const schemaResult = await execTool<{ success: boolean; schema: Record<string, unknown> | null; error?: string }>(
      schemaTool,
      { description: `An analysis result object containing:
        - summary: a string summary
        - score: a number between 0 and 100
        - tags: an array of strings` },
    );

    expect(schemaResult.success).toBe(true);
    const dynamicOutputSchema: Record<string, unknown> = schemaResult.schema as Record<string, unknown>;
    console.log("\nComplex schema:", JSON.stringify(dynamicOutputSchema, null, 2));

    // Create job and node
    const job: IJob = await storageService.createJobAsync(
      "Complex Dynamic Schema Test",
      "Test blueprint-compatible schema",
    );

    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "agent",
      "Complex Analyzer",
      "Analyzes data and returns complex structured output",
      { type: "object", properties: { data: { type: "string" } }, required: ["data"] },
      dynamicOutputSchema,
      {
        systemPrompt: `You are a data analyzer. Given data, produce a structured analysis.

        You MUST call the 'done' tool with:
        - summary: a brief text summary
        - score: number 0-100
        - tags: array of short string labels`,
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

    // Create Zod schema
    const zodSchema = createOutputZodSchema(node.outputSchema);

    // Execute
    const result = await executorService.executeJobAsync(job.jobId, {
      data: "Sales increased by 25% this quarter, with 150 new customers and 50 churned",
    });

    console.log("Complex output:", JSON.stringify(result.output, null, 2));

    expect(result.success).toBe(true);

    // Validate against Zod schema
    const validation = zodSchema.safeParse(result.output);
    expect(validation.success).toBe(true);

    const output = result.output as Record<string, unknown>;
    expect(output.summary).toBeDefined();
    expect(typeof output.score).toBe("number");
    expect(Array.isArray(output.tags)).toBe(true);
  }, 180000);
});

//#endregion Tests
