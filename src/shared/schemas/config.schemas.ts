import { z } from "zod";

//#region Config Schemas

const rateLimitSchema = z.object({
  rpm: z.number()
    .int()
    .positive()
    .describe("Requests per minute"),
  tpm: z.number()
    .int()
    .positive()
    .describe("Tokens per minute"),
});

const openRouterSchema = z.object({
  apiKey: z.string()
    .min(1)
    .describe("OpenRouter API key"),
  model: z.string()
    .min(1)
    .describe("Model identifier (e.g. anthropic/claude-sonnet-4)"),
  rateLimits: rateLimitSchema
    .default({ rpm: 60, tpm: 100000 }),
});

const openAiCompatibleSchema = z.object({
  baseUrl: z.string()
    .url()
    .describe("Base URL of the OpenAI-compatible endpoint"),
  apiKey: z.string()
    .min(1)
    .describe("API key for the endpoint"),
  model: z.string()
    .min(1)
    .describe("Model identifier"),
  rateLimits: rateLimitSchema
    .default({ rpm: 120, tpm: 200000 }),
});

const aiConfigSchema = z.object({
  provider: z.enum(["openrouter", "openai-compatible"])
    .describe("Active AI provider"),
  openrouter: openRouterSchema
    .optional(),
  openaiCompatible: openAiCompatibleSchema
    .optional(),
});

const telegramConfigSchema = z.object({
  botToken: z.string()
    .min(1)
    .describe("Telegram Bot API token"),
});

const schedulerConfigSchema = z.object({
  enabled: z.boolean()
    .default(true)
    .describe("Whether the scheduler is active"),
  notificationChatId: z.string()
    .nullable()
    .default(null)
    .describe("Telegram chat ID where cron task notifications are sent. If null, messages are logged only."),
});

const knowledgeConfigSchema = z.object({
  embeddingModelPath: z.string()
    .default("Xenova/bge-m3")
    .describe("HuggingFace model identifier for embeddings"),
  lancedbPath: z.string()
    .default("~/.betterclaw/knowledge/lancedb")
    .describe("Path to the LanceDB data directory"),
});

const skillsConfigSchema = z.object({
  directories: z.string()
    .array()
    .default(["~/.betterclaw/skills"])
    .describe("Directories to scan for skills"),
});

const loggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"])
    .default("info")
    .describe("Minimum log level"),
});

const servicesConfigSchema = z.object({
  searxngUrl: z.string()
    .url()
    .default("http://localhost:18731")
    .describe("SearXNG instance URL"),
  crawl4aiUrl: z.string()
    .url()
    .default("http://localhost:18732")
    .describe("Crawl4AI instance URL"),
});

export const configSchema = z.object({
  ai: aiConfigSchema,
  telegram: telegramConfigSchema
    .optional(),
  scheduler: schedulerConfigSchema
    .default({ enabled: true }),
  knowledge: knowledgeConfigSchema
    .default({}),
  skills: skillsConfigSchema
    .default({}),
  logging: loggingConfigSchema
    .default({}),
  services: servicesConfigSchema
    .default({}),
});

export type ConfigSchemaType = z.infer<typeof configSchema>;

//#endregion Config Schemas
