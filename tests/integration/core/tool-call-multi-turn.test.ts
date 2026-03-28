import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stringify as stringifyYaml } from "yaml";

import { createTestEnvironment, resetSingletons, loadTestConfigAsync } from "../../utils/test-helpers.js";
import { LangchainMainAgent } from "../../../src/agent/langchain-main-agent.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import { McpRegistryService } from "../../../src/services/mcp-registry.service.js";
import { LangchainMcpService } from "../../../src/services/langchain-mcp.service.js";
import { createLangchainAgent, invokeAgentAsync } from "../../../src/agent/langchain-agent.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { thinkTool } from "../../../src/tools/index.js";
import type { IConfig } from "../../../src/shared/types/config.types.js";

const env = createTestEnvironment("tool-call-multi-turn");

/**
 * E2E test that validates the agent can make tool calls and produce
 * a final response after tool execution (multi-turn conversation).
 */
describe("Tool Call Multi-Turn E2E", () => {
  beforeAll(async () => {
    await env.setupAsync({ logLevel: "error" });
    await loadTestConfigAsync(env.tempDir);

    const loggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("error", path.join(env.tempDir, "logs"));

    const configService = ConfigService.getInstance();
    await configService.initializeAsync();

    const aiConfig = configService.getConfig().ai;
    const aiCapability = AiCapabilityService.getInstance();
    aiCapability.initialize(aiConfig);

    const promptService = PromptService.getInstance();
    await promptService.initializeAsync();

    const channelRegistry = ChannelRegistryService.getInstance();
    await channelRegistry.initializeAsync();

    const skillLoader = SkillLoaderService.getInstance();
    await skillLoader.loadAllSkillsAsync([], false);

    const mcpRegistry = McpRegistryService.getInstance();
    await mcpRegistry.initializeAsync();

    const mcpService = LangchainMcpService.getInstance();
    await mcpService.refreshAsync();
  }, 60000);

  afterAll(async () => {
    resetSingletons();
    await env.teardownAsync();
  });

  describe("agent loop continuation", () => {
    it("should continue after tool execution and produce final response", async () => {
      const aiConfig = ConfigService.getInstance().getConfig().ai;
      const systemPrompt = await PromptService.getInstance().getPromptAsync("main-agent");

      const checkpointerPath = path.join(env.tempDir, "checkpoints.db");
      const checkpointer = SqliteSaver.fromConnString(checkpointerPath);

      // Create agent with think tool to test multi-turn
      const agent = createLangchainAgent({
        aiConfig,
        systemPrompt,
        tools: [thinkTool],
        checkpointer,
      });

      // Invoke agent with a request that requires tool use
      const result = await invokeAgentAsync(
        agent,
        "Think about what 2+2 equals, then tell me the answer.",
        "test-thread-multi-turn"
      );

      console.log("Multi-turn result:", JSON.stringify(result, null, 2));

      // The agent should make at least one tool call
      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      // The agent should produce a final text response (not empty)
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);

      // The response should contain the answer
      expect(result.text.toLowerCase()).toContain("4");
    }, 120000);

    it("should produce response after multiple tool calls", async () => {
      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue("msg-toolcall");
      const photoSender = vi.fn().mockResolvedValue("photo-toolcall");

      await agent.initializeForChatAsync(
        "test-chat-toolcall",
        messageSender,
        photoSender,
        undefined,
        "telegram"
      );

      // Ask something that requires using the think tool
      const result = await agent.processMessageForChatAsync(
        "test-chat-toolcall",
        "Use the think tool to plan your response, then answer: what is 5+5?"
      );

      console.log("Tool call result:", JSON.stringify(result, null, 2));

      // Should have made at least one tool call
      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      // Should produce a text response with the answer
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);

      // Should contain the answer
      expect(result.text.toLowerCase()).toContain("10");
    }, 120000);
  });
});