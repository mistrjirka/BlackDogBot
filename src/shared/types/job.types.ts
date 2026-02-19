//#region Job Types

export type JobStatus = "creating" | "ready" | "running" | "completed" | "failed";

export type NodeType =
  | "manual"
  | "curl_fetcher"
  | "crawl4ai"
  | "searxng"
  | "python_code"
  | "output_to_ai"
  | "agent";

export interface IJob {
  jobId: string;
  name: string;
  description: string;
  status: JobStatus;
  entrypointNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IAgentNodeConfig {
  systemPrompt: string;
  selectedTools: string[];
  model: string | null;
  reasoningEffort: "low" | "medium" | "high" | null;
  maxSteps: number;
}

export interface ICurlFetcherConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ICrawl4AiConfig {
  url: string;
  extractionPrompt: string | null;
  selector: string | null;
}

export interface ISearxngConfig {
  query: string;
  categories: string[];
  maxResults: number;
}

export interface IPythonCodeConfig {
  code: string;
  pythonPath: string;
  timeout: number;
}

export interface IOutputToAiConfig {
  prompt: string;
  model: string | null;
}

export type NodeConfig =
  | IAgentNodeConfig
  | ICurlFetcherConfig
  | ICrawl4AiConfig
  | ISearxngConfig
  | IPythonCodeConfig
  | IOutputToAiConfig
  | Record<string, never>;

export interface INode {
  nodeId: string;
  jobId: string;
  type: NodeType;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  connections: string[];
  config: NodeConfig;
  createdAt: string;
  updatedAt: string;
}

export interface INodeTestCase {
  testId: string;
  nodeId: string;
  jobId: string;
  name: string;
  inputData: Record<string, unknown>;
  expectedOutputSchema: Record<string, unknown> | null;
  createdAt: string;
}

export interface INodeTestResult {
  testId: string;
  passed: boolean;
  output: unknown;
  error: string | null;
  validationErrors: string[];
  executionTimeMs: number;
}

//#endregion Job Types
