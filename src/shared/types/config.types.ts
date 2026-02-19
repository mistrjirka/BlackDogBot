//#region Config Types

export interface IRateLimitConfig {
  rpm: number;
  tpm: number;
}

export interface IOpenRouterConfig {
  apiKey: string;
  model: string;
  rateLimits: IRateLimitConfig;
}

export interface IOpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  rateLimits: IRateLimitConfig;
}

export type AiProvider = "openrouter" | "openai-compatible";

export interface IAiConfig {
  provider: AiProvider;
  openrouter?: IOpenRouterConfig;
  openaiCompatible?: IOpenAiCompatibleConfig;
}

export interface ITelegramConfig {
  botToken: string;
}

export interface ISchedulerConfig {
  enabled: boolean;
}

export interface IKnowledgeConfig {
  embeddingModelPath: string;
  lancedbPath: string;
}

export interface ISkillsConfig {
  directories: string[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ILoggingConfig {
  level: LogLevel;
}

export interface IConfig {
  ai: IAiConfig;
  telegram?: ITelegramConfig;
  scheduler: ISchedulerConfig;
  knowledge: IKnowledgeConfig;
  skills: ISkillsConfig;
  logging: ILoggingConfig;
}

//#endregion Config Types
