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
  contextWindow: z.number()
    .int()
    .positive()
    .optional()
    .describe("Model context window size (optional, auto-detected for known models)"),
  supportsForcedToolChoice: z.boolean()
    .default(false)
    .describe("Whether the model supports forcing specific tool usage via tool_choice"),
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

const lmStudioSchema = z.object({
  baseUrl: z.string()
    .url()
    .describe("Base URL of the LM Studio endpoint (e.g., http://localhost:1234/v1)"),
  apiKey: z.string()
    .optional()
    .default("lm-studio")
    .describe("API key for LM Studio (usually 'lm-studio')"),
  model: z.string()
    .min(1)
    .describe("Model identifier"),
  rateLimits: rateLimitSchema
    .default({ rpm: 120, tpm: 200000 }),
});

const aiConfigSchema = z.object({
  provider: z.enum(["openrouter", "openai-compatible", "lm-studio"])
    .describe("Active AI provider"),
  openrouter: openRouterSchema
    .optional(),
  openaiCompatible: openAiCompatibleSchema
    .optional(),
  lmStudio: lmStudioSchema
    .optional(),
});

const telegramConfigSchema = z.object({
  botToken: z.string()
    .min(1)
    .describe("Telegram Bot API token"),
  allowedUsers: z.array(z.string())
    .optional()
    .describe("List of allowed Telegram user IDs. If empty or undefined, all users are allowed."),
});

const schedulerConfigSchema = z.object({
  enabled: z.boolean()
    .default(true)
    .describe("Whether the scheduler is active"),
  timezone: z.string()
    .optional()
    .describe("Timezone for cron expressions (e.g., 'Europe/Prague', 'UTC', 'America/New_York'). Defaults to server local time."),
});

const jobCreationConfigSchema = z.object({
  enabled: z.boolean()
    .default(true)
    .describe("Whether the job creation feature is enabled"),
  requirePassingNodeTests: z.boolean()
    .default(true)
    .describe("Whether all node tests must pass before finish_job_creation"),
  requireSuccessfulRunBeforeFinish: z.boolean()
    .default(true)
    .describe("Whether finish_job_creation must execute the job successfully before marking it ready"),
});

const knowledgeConfigSchema = z.object({
  embeddingProvider: z.enum(["local", "openrouter"])
    .default("local")
    .describe("Embedding backend provider: local Transformers.js model or OpenRouter embeddings API"),
  embeddingModelPath: z.string()
    .default("onnx-community/Qwen3-Embedding-0.6B-ONNX")
    .describe("HuggingFace model identifier for local embeddings"),
  embeddingDtype: z.enum(["fp32", "fp16", "q8", "q4", "q4f16"])
    .default("q8")
    .describe("Model quantization dtype. q8 is recommended for CPU (3x faster, ~95-98% quality). fp16 is recommended for GPU."),
  embeddingDevice: z.enum(["auto", "cpu", "cuda"])
    .default("auto")
    .describe("Compute device: auto (detect best available), cpu, cuda (NVIDIA). AMD ROCm users may try cuda if using a ROCm-built onnxruntime."),
  embeddingOpenRouterModel: z.string()
    .default("https://openrouter.ai/nvidia/llama-nemotron-embed-vl-1b-v2:free")
    .describe("OpenRouter embedding model identifier or URL used when embeddingProvider=openrouter"),
  embeddingOpenRouterApiKey: z.string()
    .optional()
    .describe("Optional OpenRouter API key override for embeddings. Falls back to ai.openrouter.apiKey."),
  lancedbPath: z.string()
    .default("~/.betterclaw/knowledge/lancedb")
    .describe("Path to the LanceDB data directory"),
});

const skillsConfigSchema = z.object({
  directories: z.string()
    .array()
    .default(["~/.betterclaw/skills"])
    .describe("Directories to scan for skills"),
  autoSetup: z.boolean()
    .default(true)
    .describe("Automatically set up skills with missing dependencies at boot"),
  autoSetupNotify: z.boolean()
    .default(true)
    .describe("Send notifications when skill setup completes or fails"),
  installTimeout: z.number()
    .int()
    .positive()
    .default(300000)
    .describe("Timeout in milliseconds for each install step"),
  allowedInstallKinds: z.enum(["brew", "node", "go", "uv", "pacman", "apt", "download"])
    .array()
    .default(["brew", "node", "go", "uv"])
    .describe("Whitelist of allowed install kinds. pacman, apt, and download require manual steps."),
  skipOsCheck: z.boolean()
    .default(false)
    .describe("Skip OS compatibility check for skills"),
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
  jobCreation: jobCreationConfigSchema
    .default({}),
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
