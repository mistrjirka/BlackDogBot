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
  maxConcurrent: z.number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of concurrent requests"),
});

const structuredOutputModeSchema = z.enum(["auto", "native_json_schema", "tool_emulated", "tool_auto"])
  .default("auto")
  .describe("Structured output strategy: auto, native JSON schema, tool-emulated (forced tool call), or tool-auto (best-effort tool call)");

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
  structuredOutputMode: structuredOutputModeSchema
    .optional(),
  activeProfile: z.string()
    .min(1)
    .optional()
    .describe("Active model profile name (built-in or user-defined YAML profile)"),
  profilesDir: z.string()
    .min(1)
    .optional()
    .describe("Directory containing YAML model profiles. Defaults to ~/.blackdogbot/model-profiles"),
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
  contextWindow: z.number()
    .int()
    .positive()
    .optional()
    .describe("Context window size in tokens. Required for accurate context management."),
  rateLimits: rateLimitSchema
    .default({ rpm: 120, tpm: 200000, maxConcurrent: 1 }),
  supportsStructuredOutputs: z.boolean()
    .optional()
    .describe("Whether the endpoint supports response_format: json_schema"),
  structuredOutputMode: structuredOutputModeSchema
    .optional(),
  requestTimeout: z.number()
    .int()
    .positive()
    .optional()
    .describe("Per-request timeout in milliseconds. On timeout, retries once at 2x. Default: 600000 (600s)."),
  activeProfile: z.string()
    .min(1)
    .optional()
    .describe("Active model profile name (built-in or user-defined YAML profile)"),
  profilesDir: z.string()
    .min(1)
    .optional()
    .describe("Directory containing YAML model profiles. Defaults to ~/.blackdogbot/model-profiles"),
});

const lmStudioSchema = z.object({
  baseUrl: z.string()
    .url()
    .describe("Base URL of the LM Studio endpoint (e.g., http://localhost:1234)"),
  apiKey: z.string()
    .optional()
    .default("lm-studio")
    .describe("API key for LM Studio (usually 'lm-studio')"),
  model: z.string()
    .min(1)
    .describe("Model identifier"),
  rateLimits: rateLimitSchema
    .default({ rpm: 120, tpm: 200000, maxConcurrent: 1 }),
  supportsStructuredOutputs: z.boolean()
    .optional()
    .describe("Whether LM Studio supports response_format: json_schema"),
  structuredOutputMode: structuredOutputModeSchema
    .optional(),
  contextWindow: z.number()
    .int()
    .positive()
    .optional()
    .describe("Context window size. If not set, auto-detected from LM Studio via SDK."),
  requestTimeout: z.number()
    .int()
    .positive()
    .optional()
    .describe("Per-request timeout in milliseconds. On timeout, retries once at 2x. Default: 600000 (600s)."),
  activeProfile: z.string()
    .min(1)
    .optional()
    .describe("Active model profile name (built-in or user-defined YAML profile)"),
  profilesDir: z.string()
    .min(1)
    .optional()
    .describe("Directory containing YAML model profiles. Defaults to ~/.blackdogbot/model-profiles"),
});

const aiConfigSchema = z.object({
  provider: z.enum(["openrouter", "openai-compatible", "lm-studio"])
    .describe("Active AI provider"),
  generationTimeoutMs: z.number()
    .int()
    .positive()
    .min(600_000)
    .optional()
    .describe("Global generation timeout floor in milliseconds. Requests wait at least this long before timing out. Default: 600000 (10 minutes). Minimum: 600000."),
  fallbacks: z.object({
    provider: z.enum(["openrouter", "openai-compatible", "lm-studio"]),
    model: z.string().min(1).optional(),
  }).array().optional()
    .describe("Ordered fallback providers used when the primary provider repeatedly fails"),
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
  maxParallelCrons: z.number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of cron tasks running concurrently. Default: 1."),
  cronQueueSize: z.number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum tasks queued when concurrency limit is reached. Tasks arriving when queue is full are skipped. Default: 3."),
  telegramOutboxMaxPerChat: z.number()
    .int()
    .positive()
    .default(10)
    .describe("Maximum queued unsent Telegram messages retained per chat before older pending messages are dropped."),
});

const knowledgeConfigSchema = z.object({
  embeddingProvider: z.enum(["local", "openrouter"])
    .optional()
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
    .default("~/.blackdogbot/knowledge/lancedb")
    .describe("Path to the LanceDB data directory"),
});

const skillsConfigSchema = z.object({
  directories: z.string()
    .array()
    .default(["~/.blackdogbot/skills"])
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
  fullToolArgs: z.boolean()
    .default(false)
    .describe("Include full tool call input/output in structured tool logs"),
  fullToolArgsMaxBytes: z.number()
    .int()
    .positive()
    .default(200000)
    .describe("Maximum serialized bytes for full tool argument logs before truncation"),
  llmResponseDiagnostics: z.boolean()
    .default(false)
    .describe("Log diagnostics for think tags/reasoning_content in raw LLM responses"),
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

const brainInterfaceConfigSchema = z.object({
  jwtSecret: z.string()
    .min(1)
    .default("replace-with-generated-secret")
    .describe("JWT signing secret for BrainInterface WebSocket authentication"),
  jwtIssuer: z.string()
    .min(1)
    .default("blackdogbot")
    .describe("JWT issuer for BrainInterface tokens"),
  jwtAudience: z.string()
    .min(1)
    .default("brain-interface")
    .describe("JWT audience for BrainInterface tokens"),
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
  brainInterface: brainInterfaceConfigSchema
    .default({}),
});

export type ConfigSchemaType = z.infer<typeof configSchema>;

//#endregion Config Schemas
