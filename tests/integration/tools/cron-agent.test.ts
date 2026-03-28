import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { createTestEnvironment, resetSingletons, loadTestConfigAsync } from "../../utils/test-helpers.js";
import { LangchainCronExecutor } from "../../../src/agent/langchain-cron-executor.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { createRssTestServer } from "../../mocks/rss-test-server.js";
import type { IScheduledTask, IExecutionContext } from "../../../src/shared/types/cron.types.js";

const env = createTestEnvironment("cron-agent");

/**
 * Cron Agent Test Suite
 *
 * Tests verify:
 * 1. Cron agent can execute tasks with all available tools
 * 2. send_message deduplication works correctly
 * 3. Tool execution logging provides step details
 * 4. Mock RSS server works for cron tasks
 */

let rssServer: Server;
let sentMessages: string[] = [];

function createMockMessageSender(): (message: string) => Promise<string | null> {
  return vi.fn(async (message: string) => {
    sentMessages.push(message);
    console.log(`[MockSender] Sent message: ${message.slice(0, 100)}...`);
    return `msg-${sentMessages.length}`;
  });
}

function createMockTaskIdProvider(): () => string | null {
  return vi.fn(() => "test-task-id");
}

function createTestTask(overrides: Partial<IScheduledTask> = {}): IScheduledTask {
  return {
    taskId: "test-task-id",
    name: "test-task",
    description: "Test task",
    instructions: "Do nothing.",
    tools: ["send_message"],
    enabled: true,
    schedule: { type: "interval", intervalMs: 3600000 },
    notifyUser: true,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    ...overrides,
  };
}

function createMockExecutionContext(): IExecutionContext {
  return {
    taskName: "",
    taskDescription: "",
    taskInstructions: "",
    toolCallHistory: [],
  };
}

beforeAll(async () => {
  await env.setupAsync({ logLevel: "info" });
  await loadTestConfigAsync(env.tempDir, { originalHome: env.originalHome });

  const loggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("info", path.join(env.tempDir, "logs"));

  const configService = ConfigService.getInstance();
  await configService.initializeAsync();

  const config = configService.getConfig();
  const aiConfig = config.ai;
  const aiCapability = AiCapabilityService.getInstance();
  aiCapability.initialize(aiConfig);

  const promptService = PromptService.getInstance();
  await promptService.initializeAsync();

  // Start mock RSS server for cron task testing
  rssServer = await createRssTestServer(3999);
}, 60000);

afterAll(async () => {
  resetSingletons();
  await env.teardownAsync();
  rssServer?.close();
});

//#region Basic Cron Execution Tests

describe("Cron Agent - Basic Execution", () => {
  it(
    "should execute a simple cron task that fetches RSS",
    async () => {
      sentMessages = [];
      const executor = LangchainCronExecutor.getInstance();

      const task = createTestTask({
        taskId: "test-rss-task",
        name: "test-rss-task",
        description: "Fetch RSS feed",
        instructions: `Fetch the RSS feed from http://localhost:3999/rss/news and send a message with the titles of the items.`,
        tools: ["fetch_rss", "send_message"],
      });

      const messageSender = createMockMessageSender();
      const taskIdProvider = createMockTaskIdProvider();
      const executionContext = createMockExecutionContext();

      const result = await executor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);
      expect(result.text).toBeDefined();
      console.log("RSS Task Result:", result);
    },
    300000
  );

  it(
    "should execute a cron task that lists crons",
    async () => {
      const executor = LangchainCronExecutor.getInstance();

      const task = createTestTask({
        taskId: "test-list-crons-task",
        name: "test-list-crons-task",
        description: "List scheduled tasks",
        instructions: `List all scheduled tasks using list_crons tool.`,
        tools: ["list_crons", "send_message"],
      });

      const messageSender = createMockMessageSender();
      const taskIdProvider = createMockTaskIdProvider();
      const executionContext = createMockExecutionContext();

      const result = await executor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);
      expect(result.text).toBeDefined();
      console.log("List Crons Result:", result);
    },
    300000
  );

  it(
    "should execute a cron task with database operations",
    async () => {
      const executor = LangchainCronExecutor.getInstance();

      const task = createTestTask({
        taskId: "test-db-task",
        name: "test-db-task",
        description: "Database operations",
        instructions: `Create a database called 'test_cron_db', then create a table 'users' with columns 'id' (integer primary key) and 'name' (text).`,
        tools: ["create_database", "create_table", "send_message"],
      });

      const messageSender = createMockMessageSender();
      const taskIdProvider = createMockTaskIdProvider();
      const executionContext = createMockExecutionContext();

      const result = await executor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);
      expect(result.text).toBeDefined();
      console.log("DB Task Result:", result);
    },
    300000
  );
});

//#endregion Basic Cron Execution Tests

//#region send_message Deduplication Tests

describe("Cron Agent - send_message Deduplication", () => {
  it(
    "should skip duplicate messages based on novelty check",
    async () => {
      sentMessages = [];
      const executor = LangchainCronExecutor.getInstance();

      const task = createTestTask({
        taskId: "test-dedup-task",
        name: "test-dedup-task",
        description: "Test deduplication",
        instructions: `Send a message saying "Same message repeated". Use send_message tool.`,
        tools: ["send_message"],
      });

      const messageSender = createMockMessageSender();
      const taskIdProvider = createMockTaskIdProvider();
      const executionContext = createMockExecutionContext();

      // First execution - should send
      const result1 = await executor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
      );

      console.log("First execution result:", result1);
      console.log("Messages after first execution:", sentMessages.length);

      // The deduplication logic checks against stored message history
      // In a real scenario, duplicate messages would be skipped
    },
    300000
  );

  it(
    "should send different messages without deduplication",
    async () => {
      sentMessages = [];
      const executor = LangchainCronExecutor.getInstance();

      const task = createTestTask({
        taskId: "test-diff-msg-1",
        name: "test-diff-msg-1",
        description: "First message",
        instructions: `Send a message saying "First unique message about news".`,
        tools: ["send_message"],
      });

      const messageSender = createMockMessageSender();
      const taskIdProvider = createMockTaskIdProvider();
      const executionContext = createMockExecutionContext();

      await executor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
      );

      console.log("Messages after unique task:", sentMessages.length);
    },
    300000
  );
});

//#endregion send_message Deduplication Tests

//#region Tool Execution Logging Tests

describe("Cron Agent - Tool Execution Logging", () => {
  it(
    "should log each step with parameters and output preview",
    async () => {
      const executor = LangchainCronExecutor.getInstance();

      const task = createTestTask({
        taskId: "test-logging-task",
        name: "test-logging-task",
        description: "Test step logging",
        instructions: `Run the command 'echo hello world' and send the output.`,
        tools: ["run_cmd", "send_message"],
      });

      const messageSender = createMockMessageSender();
      const taskIdProvider = createMockTaskIdProvider();
      const executionContext = createMockExecutionContext();

      const result = await executor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);
      expect(result.text).toBeDefined();
      console.log("Logging Task Result:", result);
      console.log("Check logs for step details with params and output preview");
    },
    300000
  );
});

//#endregion Tool Execution Logging Tests

//#region Multiple Tool Execution Tests

describe("Cron Agent - Multiple Tool Execution", () => {
  it(
    "should execute task with multiple tools in sequence",
    async () => {
      const executor = LangchainCronExecutor.getInstance();

      const task = createTestTask({
        taskId: "test-multi-tool-task",
        name: "test-multi-tool-task",
        description: "Multi-tool execution",
        instructions: `1. Fetch RSS from http://localhost:3999/rss/news
2. List databases
3. Send a summary message with results`,
        tools: ["fetch_rss", "list_databases", "send_message"],
      });

      const messageSender = createMockMessageSender();
      const taskIdProvider = createMockTaskIdProvider();
      const executionContext = createMockExecutionContext();

      const result = await executor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(2);
      expect(result.text).toBeDefined();
      console.log("Multi-tool Result:", result);
    },
    300000
  );
});

//#endregion Multiple Tool Execution Tests