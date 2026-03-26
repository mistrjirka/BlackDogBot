import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { vi } from "vitest";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

import { ConfigService } from "../../src/services/config.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { EmbeddingService } from "../../src/services/embedding.service.js";
import { VectorStoreService } from "../../src/services/vector-store.service.js";
import { SchedulerService } from "../../src/services/scheduler.service.js";
import { ChannelRegistryService } from "../../src/services/channel-registry.service.js";
import { MessagingService } from "../../src/services/messaging.service.js";
import { SkillLoaderService } from "../../src/services/skill-loader.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import { LangchainMainAgent } from "../../src/agent/langchain-main-agent.js";
import { McpRegistryService } from "../../src/services/mcp-registry.service.js";
import type { LogLevel } from "../../src/shared/types/index.js";
import type { IConfig } from "../../src/shared/types/config.types.js";

export type SingletonClass =
  | typeof ConfigService
  | typeof LoggerService
  | typeof EmbeddingService
  | typeof VectorStoreService
  | typeof SchedulerService
  | typeof ChannelRegistryService
  | typeof MessagingService
  | typeof SkillLoaderService
  | typeof PromptService
  | typeof LangchainMainAgent
  | typeof McpRegistryService;

export function resetSingletons(services: SingletonClass[] = []): void {
  const defaultServices: SingletonClass[] = [
    ConfigService,
    LoggerService,
    EmbeddingService,
    VectorStoreService,
    SchedulerService,
    ChannelRegistryService,
    MessagingService,
    SkillLoaderService,
    PromptService,
    LangchainMainAgent,
    McpRegistryService,
  ];

  const toReset = services.length > 0 ? services : defaultServices;

  for (const Service of toReset) {
    (Service as unknown as { _instance: unknown })._instance = null;
  }
}

export interface ITestEnvironment {
  tempDir: string;
  originalHome: string;
  setupAsync: (options?: { logLevel?: LogLevel }) => Promise<void>;
  teardownAsync: () => Promise<void>;
}

export function createTestEnvironment(prefix: string): ITestEnvironment {
  let tempDir = "";
  let originalHome = "";

  return {
    get tempDir() {
      return tempDir;
    },
    get originalHome() {
      return originalHome;
    },
    setupAsync: async (options?: { logLevel?: LogLevel }) => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `blackdogbot-${prefix}-`));
      originalHome = process.env.HOME ?? os.homedir();
      process.env.HOME = tempDir;

      resetSingletons();

      const tempConfigDir = path.join(tempDir, ".blackdogbot");
      await fs.mkdir(tempConfigDir, { recursive: true });

      const loggerService = LoggerService.getInstance();
      await loggerService.initializeAsync(
        options?.logLevel ?? "info",
        path.join(tempDir, "logs")
      );
    },
    teardownAsync: async () => {
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
      process.env.HOME = originalHome;
    },
  };
}

export async function setupVectorStoreAsync(): Promise<void> {
  const embeddingService = EmbeddingService.getInstance();
  await embeddingService.initializeAsync();

  const vectorStoreService = VectorStoreService.getInstance();
  const tempDir = process.env.HOME ?? os.homedir();
  const lanceDbPath = path.join(tempDir, ".blackdogbot", "knowledge", "lancedb");

  await vectorStoreService.initializeAsync(
    lanceDbPath,
    embeddingService.getDimension()
  );
}

export function silenceLogger(logger: LoggerService): void {
  vi.spyOn(logger, "debug").mockReturnValue(undefined);
  vi.spyOn(logger, "info").mockReturnValue(undefined);
  vi.spyOn(logger, "warn").mockReturnValue(undefined);
  vi.spyOn(logger, "error").mockReturnValue(undefined);
}

export interface ITestConfigOptions {
  ai?: IConfig["ai"];
  scheduler?: IConfig["scheduler"];
  knowledge?: IConfig["knowledge"];
  skills?: IConfig["skills"];
  logging?: IConfig["logging"];
  services?: IConfig["services"];
}

export async function loadTestConfigAsync(
  tempDir: string,
  options: ITestConfigOptions = {},
): Promise<void> {
  const configDir = path.join(tempDir, ".blackdogbot");
  await fs.mkdir(configDir, { recursive: true });

  // Read real config from the actual home directory (not process.env.HOME which is overridden)
  const realConfigPath = path.join(os.homedir(), ".blackdogbot", "config.yaml");

  let realAiConfig: IConfig["ai"] | undefined;

  try {
    const realConfigContent = await fs.readFile(realConfigPath, "utf-8");
    const realConfig = parseYaml(realConfigContent) as IConfig;
    realAiConfig = realConfig.ai;
  } catch {
    // Real config not available, use env vars or test defaults
  }

  const config: IConfig = {
    ai: options.ai ?? realAiConfig ?? {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY || "test-key",
        model: "gpt-4o-mini",
      },
    },
    scheduler: options.scheduler ?? {
      enabled: true,
      maxParallelCrons: 1,
      cronQueueSize: 3,
    },
    knowledge: options.knowledge ?? {
      embeddingProvider: "local",
      embeddingModelPath: path.join(configDir, "models", "embedding-model"),
      embeddingDtype: "fp32",
      embeddingDevice: "cpu",
      embeddingOpenRouterModel: "",
      lancedbPath: path.join(configDir, "knowledge", "lancedb"),
    },
    skills: options.skills ?? {
      directories: [path.join(configDir, "skills")],
    },
    logging: options.logging ?? {
      level: "error",
    },
    services: options.services ?? {
      searxngUrl: "http://localhost:8080",
      crawl4aiUrl: "http://localhost:8081",
    },
  };

  await fs.writeFile(
    path.join(configDir, "config.yaml"),
    stringifyYaml(config),
    "utf-8"
  );
}
