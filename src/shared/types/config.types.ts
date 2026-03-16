//#region Config Types

import type { IDiscordConfig } from "./discord.types.js";

export type EmbeddingDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
export type EmbeddingProvider = "local" | "openrouter";
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
  contextWindow?: number; // Optional, defaults to 128000 if not specified
}

export interface IOpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  rateLimits: IRateLimitConfig;
  contextWindow?: number; // Optional, defaults to 128000 if not specified
  supportsStructuredOutputs?: boolean; // Whether endpoint supports response_format: json_schema
  requestTimeout?: number; // Per-request timeout in ms, default 500000. Retries once at 2x on timeout.
}

export interface ILmStudioConfig {
  baseUrl: string;
  apiKey?: string; // Optional for LM Studio
  model: string;
  rateLimits: IRateLimitConfig;
  contextWindow?: number;
  supportsStructuredOutputs?: boolean; // Whether endpoint supports response_format: json_schema
  requestTimeout?: number; // Per-request timeout in ms, default 500000. Retries once at 2x on timeout.
}

export type AiProvider = "openrouter" | "openai-compatible" | "lm-studio";

export interface IAiConfig {
  provider: AiProvider;
  openrouter?: IOpenRouterConfig;
  openaiCompatible?: IOpenAiCompatibleConfig;
  lmStudio?: ILmStudioConfig;
}

export interface ITelegramConfig {
  botToken: string;
  allowedUsers?: string[];
}

export interface ISchedulerConfig {
  enabled: boolean;
  timezone?: string;
  maxParallelCrons?: number; // Max concurrent cron tasks. Default 1.
  cronQueueSize?: number; // Max tasks queued when at concurrency limit. Default 3. Overflow is skipped.
}

export interface IJobCreationConfig {
  enabled: boolean;
  requirePassingNodeTests: boolean;
  requireSuccessfulRunBeforeFinish: boolean;
}

export interface IKnowledgeConfig {
  embeddingProvider?: EmbeddingProvider;
  embeddingModelPath: string;
  embeddingDtype: EmbeddingDtype;
  embeddingDevice: EmbeddingDevice;
  embeddingOpenRouterModel: string;
  embeddingOpenRouterApiKey?: string;
  lancedbPath: string;
}

export interface ISkillsConfig {
  directories: string[];
  autoSetup?: boolean;
  autoSetupNotify?: boolean;
  installTimeout?: number;
  allowedInstallKinds?: ("brew" | "node" | "go" | "uv" | "pacman" | "apt" | "download")[];
  skipOsCheck?: boolean;
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
  discord?: IDiscordConfig;
  scheduler: ISchedulerConfig;
  jobCreation: IJobCreationConfig;
  knowledge: IKnowledgeConfig;
  skills: ISkillsConfig;
  logging: ILoggingConfig;
  services: IServicesConfig;
}

//#endregion Config Types
