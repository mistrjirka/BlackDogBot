//#region Job Types

export type JobStatus = "creating" | "ready" | "running" | "completed" | "failed";

export type NodeType =
  | "start"
  | "curl_fetcher"
  | "crawl4ai"
  | "searxng"
  | "rss_fetcher"
  | "python_code"
  | "output_to_ai"
  | "agent"
  | "litesql";

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

export type RssFetchMode = "latest" | "unseen";

export interface IRssFetcherConfig {
  url: string;
  maxItems: number;
  mode: RssFetchMode;
}

export interface IRssState {
  feedUrl: string;
  seenIds: string[];
  lastFetchedAt: string;
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

export interface ILiteSqlConfig {
  databaseName: string;
  tableName: string;
}

export interface IStartNodeConfig {
  scheduledTaskId: string | null;
}

export type NodeConfig =
  | IAgentNodeConfig
  | ICurlFetcherConfig
  | ICrawl4AiConfig
  | ISearxngConfig
  | IRssFetcherConfig
  | IPythonCodeConfig
  | IOutputToAiConfig
  | ILiteSqlConfig
  | IStartNodeConfig
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

export interface IJobExecutionResult {
  success: boolean;
  output: unknown;
  error: string | null;
  nodesExecuted: number;
  failedNodeId: string | null;
  failedNodeName: string | null;
  timing?: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  };
  nodeResults?: {
    nodeId: string;
    nodeName: string;
    duration: number;
  }[];
}

export type NodeExecutionStatus = "executing" | "completed" | "failed" | "skipped";

export interface INodeProgressEvent {
  jobId: string;
  nodeId: string;
  nodeName: string;
  status: NodeExecutionStatus;
}

export type OnNodeProgressCallback = (event: INodeProgressEvent) => Promise<void>;

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
