import { z } from "zod";

//#region Job Schemas

export const jobStatusSchema = z.enum([
  "creating",
  "ready",
  "running",
  "completed",
  "failed",
]);

export const nodeTypeSchema = z.enum([
  "manual",
  "curl_fetcher",
  "crawl4ai",
  "searxng",
  "rss_fetcher",
  "python_code",
  "output_to_ai",
  "agent",
]);

export const agentNodeConfigSchema = z.object({
  systemPrompt: z.string()
    .min(1)
    .describe("XML-tagged system prompt for the agent"),
  selectedTools: z.string()
    .array()
    .min(1)
    .describe("Tool names available to this agent node"),
  model: z.string()
    .nullable()
    .default(null)
    .describe("Optional model override"),
  reasoningEffort: z.enum(["low", "medium", "high"])
    .nullable()
    .default(null)
    .describe("GPT-5 reasoning effort level"),
  maxSteps: z.number()
    .int()
    .positive()
    .default(20)
    .describe("Maximum agent loop steps"),
});

export const curlFetcherConfigSchema = z.object({
  url: z.string()
    .url()
    .describe("URL to fetch"),
  method: z.string()
    .default("GET")
    .describe("HTTP method"),
  headers: z.record(z.string(), z.string())
    .default({})
    .describe("Request headers"),
  body: z.string()
    .nullable()
    .default(null)
    .describe("Request body"),
});

export const crawl4AiConfigSchema = z.object({
  url: z.string()
    .url()
    .describe("URL to crawl"),
  extractionPrompt: z.string()
    .nullable()
    .default(null)
    .describe("AI extraction prompt"),
  selector: z.string()
    .nullable()
    .default(null)
    .describe("CSS selector to scope extraction"),
});

export const searxngConfigSchema = z.object({
  query: z.string()
    .min(1)
    .describe("Search query"),
  categories: z.string()
    .array()
    .default([])
    .describe("Search categories"),
  maxResults: z.number()
    .int()
    .positive()
    .default(10)
    .describe("Maximum results to return"),
});

export const rssFetcherConfigSchema = z.object({
  url: z.string()
    .url()
    .describe("RSS/Atom feed URL"),
  maxItems: z.number()
    .int()
    .positive()
    .default(20)
    .describe("Maximum number of items to return"),
});

export const pythonCodeConfigSchema = z.object({
  code: z.string()
    .min(1)
    .describe("Python source code to execute"),
  pythonPath: z.string()
    .default("python3")
    .describe("Path to Python interpreter"),
  timeout: z.number()
    .int()
    .positive()
    .default(30000)
    .describe("Execution timeout in milliseconds"),
});

export const outputToAiConfigSchema = z.object({
  prompt: z.string()
    .min(1)
    .describe("Prompt to send to the LLM along with the node input"),
  model: z.string()
    .nullable()
    .default(null)
    .describe("Optional model override"),
});

export const nodeConfigSchema = z.union([
  agentNodeConfigSchema,
  curlFetcherConfigSchema,
  crawl4AiConfigSchema,
  searxngConfigSchema,
  pythonCodeConfigSchema,
  outputToAiConfigSchema,
  z.object({}).strict(),
]);

export const jsonSchemaPropertySchema = z.record(z.string(), z.unknown())
  .describe("JSON Schema object for node input/output validation");

export const nodeSchema = z.object({
  nodeId: z.string()
    .min(1),
  jobId: z.string()
    .min(1),
  type: nodeTypeSchema,
  name: z.string()
    .min(1)
    .describe("Human-readable node name"),
  description: z.string()
    .default("")
    .describe("Node description"),
  inputSchema: jsonSchemaPropertySchema
    .describe("JSON Schema for node input"),
  outputSchema: jsonSchemaPropertySchema
    .describe("JSON Schema for node output"),
  connections: z.string()
    .array()
    .default([])
    .describe("IDs of downstream nodes"),
  config: nodeConfigSchema,
  createdAt: z.string()
    .datetime(),
  updatedAt: z.string()
    .datetime(),
});

export const jobSchema = z.object({
  jobId: z.string()
    .min(1),
  name: z.string()
    .min(1)
    .describe("Human-readable job name"),
  description: z.string()
    .default("")
    .describe("Job description"),
  status: jobStatusSchema,
  entrypointNodeId: z.string()
    .nullable()
    .default(null)
    .describe("ID of the entrypoint node"),
  createdAt: z.string()
    .datetime(),
  updatedAt: z.string()
    .datetime(),
});

export const nodeTestCaseSchema = z.object({
  testId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
  jobId: z.string()
    .min(1),
  name: z.string()
    .min(1)
    .describe("Test case name"),
  inputData: z.record(z.string(), z.unknown())
    .describe("Test input data matching the node's input schema"),
  expectedOutputSchema: z.record(z.string(), z.unknown())
    .nullable()
    .default(null)
    .describe("Optional output schema override for this test"),
  createdAt: z.string()
    .datetime(),
});

export const nodeTestResultSchema = z.object({
  testId: z.string()
    .min(1),
  passed: z.boolean(),
  output: z.unknown(),
  error: z.string()
    .nullable()
    .default(null),
  validationErrors: z.string()
    .array()
    .default([]),
  executionTimeMs: z.number()
    .nonnegative(),
});

//#endregion Job Schemas
