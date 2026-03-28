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
import { listCronsTool, getCronTool } from "../../../src/tools/index.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";
import type { IConfig } from "../../../src/shared/types/config.types.js";

const env = createTestEnvironment("tool-call-multi-turn");

function _createCronTask(overrides: Partial<IScheduledTask> = {}): IScheduledTask {
  const nowIso: string = new Date().toISOString();

  return {
    taskId: overrides.taskId ?? "cron-test-1",
    name: overrides.name ?? "Nightly digest",
    description: overrides.description ?? "Send nightly digest",
    instructions: overrides.instructions ?? "Run nightly summary",
    tools: overrides.tools ?? ["think"],
    schedule: overrides.schedule ?? { type: "interval", intervalMs: 3600000 },
    enabled: overrides.enabled ?? true,
    notifyUser: overrides.notifyUser ?? false,
    lastRunAt: overrides.lastRunAt ?? null,
    lastRunStatus: overrides.lastRunStatus ?? null,
    lastRunError: overrides.lastRunError ?? null,
    createdAt: overrides.createdAt ?? nowIso,
    updatedAt: overrides.updatedAt ?? nowIso,
    messageHistory: overrides.messageHistory ?? [],
    messageSummary: overrides.messageSummary ?? null,
    summaryGeneratedAt: overrides.summaryGeneratedAt ?? null,
  };
}

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
      const scheduler = SchedulerService.getInstance();
      await scheduler.removeAllTasksAsync();

      await scheduler.addTaskAsync(
        _createCronTask({
          taskId: "cron-test-1",
          name: "Morning Brief",
          description: "Daily morning briefing",
          tools: ["think", "list_crons", "get_cron"],
        }),
      );

      const aiConfig = ConfigService.getInstance().getConfig().ai;
      const systemPrompt = await PromptService.getInstance().getPromptAsync("main-agent");

      const checkpointerPath = path.join(env.tempDir, "checkpoints.db");
      const checkpointer = SqliteSaver.fromConnString(checkpointerPath);

      // Create agent with real cron tools to enforce real multi-turn tool usage
      const agent = createLangchainAgent({
        aiConfig,
        systemPrompt,
        tools: [listCronsTool, getCronTool],
        checkpointer,
      });

      // Invoke agent with request that requires list->get multi-turn tool calls
      const result = await invokeAgentAsync(
        agent,
        "List scheduled tasks, then fetch full details for cron-test-1, then summarize name and schedule.",
        "test-thread-multi-turn"
      );

      console.log("Multi-turn result:", JSON.stringify(result, null, 2));

      // The agent should make at least one tool call
      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      // The agent should produce a final text response (not empty)
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);

      // The response should contain cron details rather than arithmetic direct answer
      expect(result.text.toLowerCase()).toContain("morning brief");
      expect(result.text.toLowerCase()).toContain("schedule");
    }, 120000);

    it("should produce response after multiple tool calls", async () => {
      const scheduler = SchedulerService.getInstance();
      await scheduler.removeAllTasksAsync();

      await scheduler.addTaskAsync(
        _createCronTask({
          taskId: "cron-other-1",
          name: "Background Cleanup",
          description: "non-target task",
          instructions: "IGNORE_ME",
          tools: ["think", "list_crons", "get_cron"],
        }),
      );

      await scheduler.addTaskAsync(
        _createCronTask({
          taskId: "cron-target-42",
          name: "Target Task",
          description: "needle-desc-42",
          instructions: "INSTR_UNIQUE_42_TOKEN",
          tools: ["think", "list_crons", "get_cron"],
          schedule: { type: "interval", intervalMs: 987654 },
        }),
      );

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

      // Ask for fields that require list_crons then get_cron (instructions are only in get_cron)
      const result = await agent.processMessageForChatAsync(
        "test-chat-toolcall",
        "Find the scheduled task whose description is exactly needle-desc-42. First list tasks to discover its taskId, then fetch full details for that task, then return exactly: taskId|instructions|intervalMs."
      );

      console.log("Tool call result:", JSON.stringify(result, null, 2));

      // Should require at least two tool calls (list + get)
      expect(result.stepsCount).toBeGreaterThanOrEqual(2);

      // Should produce a text response with the answer
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);

      // Should contain fetched values that are not present in prompt
      expect(result.text).toContain("cron-target-42");
      expect(result.text).toContain("INSTR_UNIQUE_42_TOKEN");
      expect(result.text).toContain("987654");
    }, 120000);
  });
});
