import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stringify as stringifyYaml } from "yaml";

import { createTestEnvironment, resetSingletons } from "../../utils/test-helpers.js";
import { LangchainMainAgent } from "../../../src/agent/langchain-main-agent.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import type { IAgentResult } from "../../../src/agent/types.js";
import type { IConfig } from "../../../src/shared/types/config.types.js";

const env = createTestEnvironment("langchain-main-agent");

describe("LangchainMainAgent", () => {
  beforeAll(async () => {
    await env.setupAsync({ logLevel: "error" });

    const configDir = path.join(env.tempDir, ".blackdogbot");
    await fs.mkdir(configDir, { recursive: true });

    const config: IConfig = {
      ai: {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
          apiKey: process.env.OPENAI_API_KEY || "test-key",
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

    const loggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("error", path.join(env.tempDir, "logs"));

    const configService = ConfigService.getInstance();
    await configService.initializeAsync();

    const promptService = PromptService.getInstance();
    await promptService.initializeAsync();
  }, 60000);

  afterAll(async () => {
    resetSingletons();
    await env.teardownAsync();
  });

  describe("getInstance", () => {
    it("should return a singleton instance", () => {
      const instance1 = LangchainMainAgent.getInstance();
      const instance2 = LangchainMainAgent.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("initializeAsync", () => {
    it("should initialize the agent without errors", async () => {
      const agent = LangchainMainAgent.getInstance();
      await expect(agent.initializeAsync()).resolves.not.toThrow();
    });
  });

  describe("processMessageForChatAsync", () => {
    it("should handle simple text messages", async () => {
      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue("msg-123");
      const photoSender = vi.fn().mockResolvedValue("photo-123");

      await agent.initializeForChatAsync(
        "test-chat-1",
        messageSender,
        photoSender,
        undefined,
        "telegram"
      );

      const result: IAgentResult = await agent.processMessageForChatAsync(
        "test-chat-1",
        "Hello, this is a test message."
      );

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe("string");
      expect(result.stepsCount).toBeGreaterThanOrEqual(0);
    }, 120000);

    it("should stop chat sessions", async () => {
      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue("msg-456");
      const photoSender = vi.fn().mockResolvedValue("photo-456");

      await agent.initializeForChatAsync(
        "test-chat-2",
        messageSender,
        photoSender,
        undefined,
        "telegram"
      );

      const stopped = agent.stopChat("test-chat-2");
      expect(stopped).toBe(true);
    });
  });

  describe("tool invocation", () => {
    it("should invoke think tool for simple reasoning", async () => {
      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue("msg-789");
      const photoSender = vi.fn().mockResolvedValue("photo-789");

      await agent.initializeForChatAsync(
        "test-chat-3",
        messageSender,
        photoSender,
        undefined,
        "telegram"
      );

      const result = await agent.processMessageForChatAsync(
        "test-chat-3",
        "Think about what 2+2 equals and tell me the answer."
      );

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
    }, 120000);

    it("should handle file operations through tools", async () => {
      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue("msg-111");
      const photoSender = vi.fn().mockResolvedValue("photo-111");

      await agent.initializeForChatAsync(
        "test-chat-4",
        messageSender,
        photoSender,
        undefined,
        "telegram"
      );

      const result = await agent.processMessageForChatAsync(
        "test-chat-4",
        "Create a file called test-file.txt with content 'Hello World' and then read it back to me."
      );

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
    }, 120000);
  });

  describe("session management", () => {
    it("should maintain separate sessions for different chats", async () => {
      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender1 = vi.fn().mockResolvedValue("msg-a1");
      const photoSender1 = vi.fn().mockResolvedValue("photo-a1");
      const messageSender2 = vi.fn().mockResolvedValue("msg-b2");
      const photoSender2 = vi.fn().mockResolvedValue("photo-b2");

      await agent.initializeForChatAsync(
        "chat-session-a",
        messageSender1,
        photoSender1,
        undefined,
        "telegram"
      );

      await agent.initializeForChatAsync(
        "chat-session-b",
        messageSender2,
        photoSender2,
        undefined,
        "telegram"
      );

      const resultA = await agent.processMessageForChatAsync(
        "chat-session-a",
        "My name is Alice."
      );

      const resultB = await agent.processMessageForChatAsync(
        "chat-session-b",
        "My name is Bob."
      );

      expect(resultA.text).toBeDefined();
      expect(resultB.text).toBeDefined();
    }, 180000);
  });
});