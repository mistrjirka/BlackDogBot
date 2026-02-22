//#region Config Types

export type EmbeddingDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
// Note: @huggingface/transformers ONNX backend only supports "cuda" (NVIDIA) and "cpu".
// AMD ROCm is not exposed as a separate device — ROCm users can try "cuda" if their
// ROCm install provides a CUDA-compatible onnxruntime build.
export type EmbeddingDevice = "auto" | "cpu" | "cuda";

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
  notificationChatId: string | null;
}

export interface IKnowledgeConfig {
  embeddingModelPath: string;
  embeddingDtype: EmbeddingDtype;
  embeddingDevice: EmbeddingDevice;
  lancedbPath: string;
}

export interface ISkillsConfig {
  directories: string[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ILoggingConfig {
  level: LogLevel;
}

export interface IServicesConfig {
  searxngUrl: string;
  crawl4aiUrl: string;
}

export interface IConfig {
  ai: IAiConfig;
  telegram?: ITelegramConfig;
  scheduler: ISchedulerConfig;
  knowledge: IKnowledgeConfig;
  skills: ISkillsConfig;
  logging: ILoggingConfig;
  services: IServicesConfig;
}

//#endregion Config Types
