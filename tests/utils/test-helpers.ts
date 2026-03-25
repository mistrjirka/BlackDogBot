import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { vi } from "vitest";

import { ConfigService } from "../../src/services/config.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { EmbeddingService } from "../../src/services/embedding.service.js";
import { VectorStoreService } from "../../src/services/vector-store.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { SchedulerService } from "../../src/services/scheduler.service.js";
import { ChannelRegistryService } from "../../src/services/channel-registry.service.js";
import { MessagingService } from "../../src/services/messaging.service.js";
import { SkillLoaderService } from "../../src/services/skill-loader.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import { LangchainMainAgent } from "../../src/agent/langchain-main-agent.js";
import { McpRegistryService } from "../../src/services/mcp-registry.service.js";
import { McpService } from "../../src/services/mcp.service.js";
import type { LogLevel } from "../../src/shared/types/index.js";

export type SingletonClass =
  | typeof ConfigService
  | typeof LoggerService
  | typeof EmbeddingService
  | typeof VectorStoreService
  | typeof AiProviderService
  | typeof SchedulerService
  | typeof ChannelRegistryService
  | typeof MessagingService
  | typeof SkillLoaderService
  | typeof RateLimiterService
  | typeof PromptService
  | typeof LangchainMainAgent
  | typeof McpRegistryService
  | typeof McpService;

export function resetSingletons(services: SingletonClass[] = []): void {
  const defaultServices: SingletonClass[] = [
    ConfigService,
    LoggerService,
    EmbeddingService,
    VectorStoreService,
    AiProviderService,
    SchedulerService,
    ChannelRegistryService,
    MessagingService,
    SkillLoaderService,
    RateLimiterService,
    PromptService,
    LangchainMainAgent,
    McpRegistryService,
    McpService,
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
