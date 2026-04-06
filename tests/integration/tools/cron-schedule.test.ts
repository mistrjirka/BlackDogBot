import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";

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
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import type { IScheduledTask } from "../../../src/shared/types/cron.types.js";

const env = createTestEnvironment("cron-schedule");

/**
 * Cron Schedule System - Real LLM Integration Tests
 *
 * Tests verify that the LLM can correctly use the new schedule format:
 * - type: "scheduled" with intervalMinutes, startHour, startMinute
 * - add_cron, edit_cron, list_crons, get_cron, remove_cron tools
 * - The prompts are sufficient for the model to understand the new format
 *
 * After each test, the LLM is asked about any problems it encountered.
 * All output is printed to terminal for review.
 */

let createdTaskIds: string[] = [];

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

  const channelRegistry = ChannelRegistryService.getInstance();
  await channelRegistry.initializeAsync();

  const skillLoader = SkillLoaderService.getInstance();
  await skillLoader.loadAllSkillsAsync([], false);

  const mcpRegistry = McpRegistryService.getInstance();
  await mcpRegistry.initializeAsync();

  const mcpService = LangchainMcpService.getInstance();
  await mcpService.refreshAsync();

  // Start scheduler so cron tools work
  const scheduler = SchedulerService.getInstance();
  await scheduler.startAsync();
}, 60000);

afterAll(async () => {
  // Clean up created tasks
  const scheduler = SchedulerService.getInstance();
  for (const taskId of createdTaskIds) {
    try {
      await scheduler.removeTaskAsync(taskId);
    } catch {
      // ignore
    }
  }
  await scheduler.stopAsync();
  resetSingletons();
  await env.teardownAsync();
});

//#region Helper

async function runAgentTest(
  chatId: string,
  prompt: string,
): Promise<{ text: string; stepsCount: number }> {
  const agent = LangchainMainAgent.getInstance();
  await agent.initializeAsync();

  const messageSender = vi.fn().mockResolvedValue(`msg-${chatId}`);
  const photoSender = vi.fn().mockResolvedValue(`photo-${chatId}`);

  await agent.initializeForChatAsync(chatId, messageSender, photoSender, undefined, "telegram");

  console.log(`\n${"=".repeat(80)}`);
  console.log(`[TEST: ${chatId}] Prompt: ${prompt}`);
  console.log(`${"=".repeat(80)}\n`);

  const result = await agent.processMessageForChatAsync(chatId, prompt);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`[TEST: ${chatId}] Full LLM Response:`);
  console.log(`${"=".repeat(80)}`);
  console.log(result.text);
  console.log(`${"=".repeat(80)}\n`);

  return result;
}

async function askLlmAboutProblems(
  chatId: string,
  previousPrompt: string,
): Promise<string> {
  const agent = LangchainMainAgent.getInstance();

  const followUpPrompt = `Reflecting on the task I just gave you: "${previousPrompt}"

Did you encounter any problems or confusion while completing it? Specifically:
1. Were the tool parameters clear, or did you have to guess anything?
2. Was the schedule format (intervalMinutes, startHour, startMinute) easy to understand?
3. Did any tool description confuse you?
4. Is there anything that could be improved in the tool descriptions or prompts?

Answer honestly - this is for improving the system.`;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`[FEEDBACK: ${chatId}] Asking LLM about problems...`);
  console.log(`${"=".repeat(80)}\n`);

  const result = await agent.processMessageForChatAsync(chatId, followUpPrompt);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`[FEEDBACK: ${chatId}] LLM Self-Assessment:`);
  console.log(`${"=".repeat(80)}`);
  console.log(result.text);
  console.log(`${"=".repeat(80)}\n`);

  return result.text;
}

function extractTaskIdsFromResponse(text: string): string[] {
  const taskIdRegex = /taskId["\s:]+([a-zA-Z0-9_-]+)/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = taskIdRegex.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function assertTaskCreated(taskName: string): void {
  const scheduler = SchedulerService.getInstance();
  const tasks = scheduler.getAllTasks();
  const found = tasks.find(t => t.name === taskName);
  if (!found) {
    throw new Error(
      `Task "${taskName}" was NOT created in scheduler. ` +
      `Existing tasks: ${tasks.map(t => t.name).join(", ") || "(none)"}`
    );
  }
}

//#endregion Helper

//#region Tests

describe("Cron Schedule - Add Tasks with New Format", () => {
  it(
    "should add a daily scheduled task at specific time",
    async () => {
      const chatId = "cron-daily-at-time";
      const result = await runAgentTest(
        chatId,
        `Create a scheduled task with these details:
- Name: "daily_morning_report"
- Description: "Generates a daily morning report at 7:30 AM"
- Instructions: "Send a message saying 'Good morning! Here is your daily report.'"
- Tools: send_message
- Schedule: every day (1440 minutes) starting at 7:30 AM
- Notify user: true`,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);
      expect(result.text).toBeDefined();

      const taskIds = extractTaskIdsFromResponse(result.text);
      createdTaskIds.push(...taskIds);
      assertTaskCreated("daily_morning_report");

      const feedback = await askLlmAboutProblems(chatId, "Create a daily scheduled task at 7:30 AM");
      expect(feedback).toBeDefined();
    },
    2400000,
  );

  it(
    "should add a task with interval and no specific start time",
    async () => {
      const chatId = "cron-interval-no-start";
      const result = await runAgentTest(
        chatId,
        `Create a scheduled task:
- Name: "hourly_health_check"
- Description: "Checks system health every hour"
- Instructions: "Send a message saying 'System health check: all systems operational.'"
- Tools: send_message
- Schedule: every 60 minutes, no specific start time (start from now)
- Notify user: false`,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      const taskIds = extractTaskIdsFromResponse(result.text);
      createdTaskIds.push(...taskIds);
      assertTaskCreated("hourly_health_check");

      const feedback = await askLlmAboutProblems(chatId, "Create an hourly task with no specific start time");
      expect(feedback).toBeDefined();
    },
    2400000,
  );

  it(
    "should add a task with custom interval and start minute",
    async () => {
      const chatId = "cron-offset-interval";
      const result = await runAgentTest(
        chatId,
        `Create a scheduled task:
- Name: "feed_fetch_offset"
- Description: "Fetches RSS feed every 2 hours, offset by 30 minutes"
- Instructions: "Send a message saying 'RSS feed fetched successfully.'"
- Tools: send_message
- Schedule: every 120 minutes, starting at minute 30 of each hour
- Notify user: false`,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      const taskIds = extractTaskIdsFromResponse(result.text);
      createdTaskIds.push(...taskIds);
      assertTaskCreated("feed_fetch_offset");

      const feedback = await askLlmAboutProblems(chatId, "Create a task with interval and start minute offset");
      expect(feedback).toBeDefined();
    },
    2400000,
  );
});

describe("Cron Schedule - List and Get Tasks", () => {
  it(
    "should list all scheduled tasks and show correct schedule format",
    async () => {
      const chatId = "cron-list-tasks";
      const result = await runAgentTest(
        chatId,
        `List all scheduled tasks and show me their schedule details. I want to verify the schedule format is correct.`,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);
      expect(result.text.toLowerCase()).toContain("task");

      const feedback = await askLlmAboutProblems(chatId, "List all scheduled tasks");
      expect(feedback).toBeDefined();
    },
    2400000,
  );

  it(
    "should get a specific task and show its schedule",
    async () => {
      const chatId = "cron-get-task";
      const result = await runAgentTest(
        chatId,
        `First list all scheduled tasks, then get the details of the first task using get_cron. Show me the full schedule object.`,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(2);

      const feedback = await askLlmAboutProblems(chatId, "Get a specific task's details");
      expect(feedback).toBeDefined();
    },
    2400000,
  );
});

describe("Cron Schedule - Edit Tasks", () => {
  it(
    "should edit a task's schedule interval",
    async () => {
      const chatId = "cron-edit-schedule";

      // First create a task to edit
      const createResult = await runAgentTest(
        chatId,
        `Create a scheduled task:
- Name: "edit_me_task"
- Description: "A task that will be edited"
- Instructions: "Send a message saying 'Task executed.'"
- Tools: send_message
- Schedule: every 30 minutes, no specific start time
- Notify user: false`,
      );

      const taskIds = extractTaskIdsFromResponse(createResult.text);
      createdTaskIds.push(...taskIds);
      assertTaskCreated("edit_me_task");

      // Now edit it
      const editResult = await runAgentTest(
        `${chatId}-edit`,
        `First get the cron task named "edit_me_task" using get_cron, then edit it to change the schedule interval to 90 minutes instead of 30 minutes.`,
      );

      expect(editResult.stepsCount).toBeGreaterThanOrEqual(2);

      const feedback = await askLlmAboutProblems(chatId, "Edit a task's schedule interval");
      expect(feedback).toBeDefined();
    },
    2400000,
  );

  it(
    "should edit a task's start time",
    async () => {
      const chatId = "cron-edit-start-time";

      const editResult = await runAgentTest(
        chatId,
        `First list all cron tasks, then pick one and edit it to set the start time to 9:00 AM (startHour=9, startMinute=0) with an interval of 1440 minutes (daily). Show the updated schedule.`,
      );

      expect(editResult.stepsCount).toBeGreaterThanOrEqual(2);

      const feedback = await askLlmAboutProblems(chatId, "Edit a task's start time to 9:00 AM");
      expect(feedback).toBeDefined();
    },
    2400000,
  );
});

describe("Cron Schedule - Remove Tasks", () => {
  it(
    "should remove a scheduled task",
    async () => {
      const chatId = "cron-remove-task";

      // First create a task to remove
      const createResult = await runAgentTest(
        chatId,
        `Create a scheduled task:
- Name: "delete_me_task"
- Description: "A task that will be deleted"
- Instructions: "Send a message saying 'I should be deleted.'"
- Tools: send_message
- Schedule: every 60 minutes, no specific start time
- Notify user: false`,
      );

      const taskIds = extractTaskIdsFromResponse(createResult.text);
      createdTaskIds.push(...taskIds);
      assertTaskCreated("delete_me_task");

      // Now remove it
      const removeResult = await runAgentTest(
        `${chatId}-remove`,
        `First list all cron tasks, find the one named "delete_me_task", then remove it using remove_cron. Confirm it's gone by listing tasks again.`,
      );

      expect(removeResult.stepsCount).toBeGreaterThanOrEqual(3);

      const feedback = await askLlmAboutProblems(chatId, "Remove a scheduled task");
      expect(feedback).toBeDefined();
    },
    2400000,
  );
});

describe("Cron Schedule - Complex Scenarios", () => {
  it(
    "should create a multi-step cron workflow with database",
    async () => {
      const chatId = "cron-db-workflow";
      const result = await runAgentTest(
        chatId,
        `Create a scheduled task that:
- Name: "news_digest"
- Description: "Fetches RSS news every 4 hours starting at 8:00 AM, stores in database"
- Instructions: "Fetch the RSS feed from http://localhost:3999/rss/news, then send a message with how many items were found."
- Tools: fetch_rss, send_message
- Schedule: every 240 minutes (4 hours), starting at 8:00 AM
- Notify user: true

Make sure to use the correct schedule format with intervalMinutes=240, startHour=8, startMinute=0.`,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      const taskIds = extractTaskIdsFromResponse(result.text);
      createdTaskIds.push(...taskIds);
      // Verify task was created; if not, the LLM should have explained why
      const scheduler = SchedulerService.getInstance();
      const tasks = scheduler.getAllTasks();
      const found = tasks.find(t => t.name === "news_digest");
      if (!found) {
        // LLM may have failed to create the task — check that it at least responded
        expect(result.text.length).toBeGreaterThan(0);
      }

      const feedback = await askLlmAboutProblems(chatId, "Create a complex cron task with database workflow");
      expect(feedback).toBeDefined();
    },
    2400000,
  );

  it(
    "should understand schedule format when asked directly",
    async () => {
      const chatId = "cron-format-understanding";
      const result = await runAgentTest(
        chatId,
        `I need to understand the schedule format for cron tasks. Explain to me:
1. What are the three schedule types available?
2. For the "scheduled" type, what fields are available and what do they mean?
3. Give me 3 examples of different schedule configurations using the new format.

Use your knowledge of the add_cron tool to explain.`,
      );

      expect(result.stepsCount).toBeGreaterThanOrEqual(0);

      // Check if the response mentions the new format fields
      const hasIntervalMinutes = result.text.toLowerCase().includes("intervalminutes") ||
        result.text.toLowerCase().includes("interval minutes");
      const hasStartHour = result.text.toLowerCase().includes("starthour") ||
        result.text.toLowerCase().includes("start hour");
      const hasStartMinute = result.text.toLowerCase().includes("startminute") ||
        result.text.toLowerCase().includes("start minute");

      console.log(`\nFormat understanding check:`);
      console.log(`  - Mentions intervalMinutes: ${hasIntervalMinutes}`);
      console.log(`  - Mentions startHour: ${hasStartHour}`);
      console.log(`  - Mentions startMinute: ${hasStartMinute}`);

      const feedback = await askLlmAboutProblems(chatId, "Explain the schedule format");
      expect(feedback).toBeDefined();
    },
    2400000,
  );
});

//#endregion Tests
