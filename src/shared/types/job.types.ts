//#region Job Types

export type NodeType =
  | "start"
  | "curl_fetcher"
  | "crawl4ai"
  | "searxng"
  | "rss_fetcher"
  | "python_code"
  | "output_to_ai"
  | "agent"
  | "litesql"
  | "litesql_reader";

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

export interface ILiteSqlReaderConfig {
  databaseName: string;
  tableName: string;
  where: string | null;
  orderBy: string | null;
  limit: number | null;
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
  | ILiteSqlReaderConfig
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

//#endregion Job Types
