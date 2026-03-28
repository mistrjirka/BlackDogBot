import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stringify as stringifyYaml } from "yaml";

import { createTestEnvironment, resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { EmbeddingService } from "../../../src/services/embedding.service.js";
import { VectorStoreService } from "../../../src/services/vector-store.service.js";
import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { MessagingService } from "../../../src/services/messaging.service.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { McpRegistryService } from "../../../src/services/mcp-registry.service.js";
import { LangchainMcpService } from "../../../src/services/langchain-mcp.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { LangchainMainAgent } from "../../../src/agent/langchain-main-agent.js";
import type { IConfig } from "../../../src/shared/types/config.types.js";

const env = createTestEnvironment("startup-e2e");

/**
 * This test validates the full initialization sequence that matches
 * the mainAsync() function in src/index.ts. It ensures that all
 * services are initialized in the correct order and no service
 * is used before it's initialized.
 */
describe("Startup Sequence E2E", () => {
  beforeAll(async () => {
    await env.setupAsync({ logLevel: "error" });

    const configDir = path.join(env.tempDir, ".blackdogbot");
    await fs.mkdir(configDir, { recursive: true });

    // Create minimal config for startup test
    const config: IConfig = {
      ai: {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "test-key",
          model: "gpt-4o-mini",
        },
      },
      scheduler: {
        enabled: true,
        maxParallelCrons: 1,
        cronQueueSize: 3,
      },
      knowledge: {
        embeddingProvider: "local",
        embeddingModelPath: path.join(configDir, "models", "embedding-model"),
        embeddingDtype: "fp32",
        embeddingDevice: "cpu",
        embeddingOpenRouterModel: "",
        lancedbPath: path.join(configDir, "knowledge", "lancedb"),
      },
      skills: {
        directories: [path.join(configDir, "skills")],
      },
      logging: {
        level: "error",
      },
      services: {
        searxngUrl: "http://localhost:8080",
        crawl4aiUrl: "http://localhost:8081",
      },
    };

    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      stringifyYaml(config),
      "utf-8"
    );
  }, 60000);

  afterAll(async () => {
    resetSingletons();
    await env.teardownAsync();
  });

  describe("initialization order", () => {
    it("should initialize ConfigService first", async () => {
      const configService = ConfigService.getInstance();
      await expect(configService.initializeAsync()).resolves.not.toThrow();

      const config = configService.getConfig();
      expect(config).toBeDefined();
      expect(config.ai).toBeDefined();
    });

    it("should initialize AiCapabilityService after ConfigService", async () => {
      const configService = ConfigService.getInstance();
      const config = configService.getConfig();

      const aiCapability = AiCapabilityService.getInstance();
      expect(() => aiCapability.initialize(config.ai)).not.toThrow();

      const capability = aiCapability.getCapabilityInfo();
      expect(capability.activeProvider).toBe("openai-compatible");
    });

    it("should initialize PromptService before LangchainMainAgent", async () => {
      const promptService = PromptService.getInstance();
      await expect(promptService.initializeAsync()).resolves.not.toThrow();

      // Verify PromptService is now initialized
      await expect(
        promptService.getPromptAsync("main-agent")
      ).resolves.toBeDefined();
    });

    it("should initialize LangchainMainAgent after PromptService", async () => {
      const langchainMainAgent = LangchainMainAgent.getInstance();
      await expect(langchainMainAgent.initializeAsync()).resolves.not.toThrow();
    });

    it("should initialize SkillLoaderService", async () => {
      const skillLoader = SkillLoaderService.getInstance();
      await expect(
        skillLoader.loadAllSkillsAsync([], false)
      ).resolves.not.toThrow();
    });

    it("should initialize SchedulerService", async () => {
      const scheduler = SchedulerService.getInstance();
      // SchedulerService loads tasks when startAsync is called
      const tasks = scheduler.getAllTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });

    it("should initialize MessagingService", async () => {
      const messaging = MessagingService.getInstance();
      // MessagingService just needs getInstance()
      expect(messaging).toBeDefined();
    });

    it("should initialize ChannelRegistryService", async () => {
      const channelRegistry = ChannelRegistryService.getInstance();
      await expect(channelRegistry.initializeAsync()).resolves.not.toThrow();
    });

    it("should initialize McpRegistryService", async () => {
      const mcpRegistry = McpRegistryService.getInstance();
      await expect(mcpRegistry.initializeAsync()).resolves.not.toThrow();
    });

    it("should initialize LangchainMcpService", async () => {
      const mcpService = LangchainMcpService.getInstance();
      await expect(mcpService.refreshAsync()).resolves.not.toThrow();

      const tools = mcpService.getTools();
      expect(Array.isArray(tools)).toBe(true);
    });
  });

  describe("service dependencies", () => {
    it("should have all services properly initialized after startup sequence", async () => {
      // Verify ConfigService
      const config = ConfigService.getInstance().getConfig();
      expect(config.ai.provider).toBe("openai-compatible");

      // Verify AiCapabilityService
      const capability = AiCapabilityService.getInstance().getCapabilityInfo();
      expect(capability.activeProvider).toBe("openai-compatible");

      // Verify PromptService
      const prompt = await PromptService.getInstance().getPromptAsync("main-agent");
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);

      // Verify LangchainMainAgent
      const mainAgent = LangchainMainAgent.getInstance();
      expect(mainAgent.isInitializedForChat("test-chat")).toBe(false);

      // Verify SkillLoaderService
      const skills = SkillLoaderService.getInstance().getAllSkills();
      expect(Array.isArray(skills)).toBe(true);

      // Verify MessagingService
      const messaging = MessagingService.getInstance();
      expect(messaging).toBeDefined();

      // Verify ChannelRegistryService
      const channels = ChannelRegistryService.getInstance().getAllChannels();
      expect(Array.isArray(channels)).toBe(true);

      // Verify McpRegistryService
      const mcpServers = McpRegistryService.getInstance().getAllServers();
      expect(Array.isArray(mcpServers)).toBe(true);

      // Verify LangchainMcpService
      const mcpTools = LangchainMcpService.getInstance().getTools();
      expect(Array.isArray(mcpTools)).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should fail gracefully if ConfigService not initialized", async () => {
      resetSingletons([ConfigService]);

      const configService = ConfigService.getInstance();
      expect(() => configService.getConfig()).toThrow("not initialized");
    });

    it("should fail gracefully if PromptService not initialized", async () => {
      resetSingletons([PromptService]);

      const promptService = PromptService.getInstance();
      await expect(
        promptService.getPromptAsync("main-agent")
      ).rejects.toThrow("not initialized");
    });
  });
});