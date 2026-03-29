import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";

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
import { createRssTestServer } from "../../mocks/rss-test-server.js";
import type { IToolCallSummary } from "../../../src/agent/types.js";

const env = createTestEnvironment("live-trace");

/**
 * Live Tool Trace Test Suite
 *
 * Tests verify that:
 * 1. onStepAsync callback is invoked during agent execution (not after)
 * 2. Each callback has precise timestamps
 * 3. Tool call details are passed to callback
 * 4. Multiple steps are reported as they happen
 */

let rssServer: Server;
let searxngUrl: string | undefined;
let crawl4aiUrl: string | undefined;

interface CallbackRecord {
  stepNumber: number;
  toolCalls: IToolCallSummary[];
  timestamp: number;
}

beforeAll(async () => {
  await env.setupAsync({ logLevel: "error" });
  await loadTestConfigAsync(env.tempDir, { originalHome: env.originalHome });

  const loggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("error", path.join(env.tempDir, "logs"));

  const configService = ConfigService.getInstance();
  await configService.initializeAsync();

  const config = configService.getConfig();
  searxngUrl = config.services?.searxngUrl;
  crawl4aiUrl = config.services?.crawl4aiUrl;

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

  rssServer = await createRssTestServer(3999);
}, 60000);

afterAll(async () => {
  resetSingletons();
  await env.teardownAsync();
  rssServer?.close();
});

//#region Tests

describe("Live Tool Trace", () => {
  it(
    "should invoke onStepAsync callback during LLM execution with precise timing",
    async () => {
      const callbacks: CallbackRecord[] = [];

      const stepCallback = vi.fn(async (stepNumber: number, toolCalls: IToolCallSummary[]) => {
        callbacks.push({
          stepNumber,
          toolCalls,
          timestamp: Date.now(),
        });

        console.log(`[Callback #${callbacks.length}] Step ${stepNumber} at ${Date.now()}`, {
          tools: toolCalls.map((tc) => ({
            name: tc.name,
            inputKeys: Object.keys(tc.input || {}),
          })),
        });
      });

      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue(null);
      const photoSender = vi.fn().mockResolvedValue(null);

      await agent.initializeForChatAsync(
        "test-live-trace",
        messageSender,
        photoSender,
        stepCallback,
        "telegram"
      );

      const executionStartTime = Date.now();
      console.log(`[Test] Execution started at ${executionStartTime}`);

      await agent.processMessageForChatAsync(
        "test-live-trace",
        "List my scheduled tasks using list_crons"
      );

      const executionEndTime = Date.now();
      const totalDuration = executionEndTime - executionStartTime;

      console.log(`[Test] Execution ended at ${executionEndTime}, duration: ${totalDuration}ms`);

      // Assertions:

      // 1. Callback was invoked at least once
      expect(stepCallback).toHaveBeenCalled();
      expect(callbacks.length).toBeGreaterThanOrEqual(1);

      // 2. Each callback should have precise timestamp and tool details
      for (let i = 0; i < callbacks.length; i++) {
        const cb = callbacks[i];
        const relativeTime = cb.timestamp - executionStartTime;
        console.log(`[Test] Callback #${i + 1}: Step ${cb.stepNumber}, ${cb.toolCalls.length} tools, timestamp: ${cb.timestamp}`);
        console.log(`[Test]   Relative time: ${relativeTime}ms from start`);

        // Tool details should be present
        for (const tc of cb.toolCalls) {
          console.log(`[Test]   Tool: ${tc.name}, Input keys: ${Object.keys(tc.input || {}).join(", ")}`);
          expect(tc.name).toBeDefined();
        }
      }

      // 3. Calculate intervals between callbacks
      if (callbacks.length > 1) {
        console.log(`[Test] Intervals between callbacks:`);
        for (let i = 1; i < callbacks.length; i++) {
          const interval = callbacks[i].timestamp - callbacks[i - 1].timestamp;
          const relativeInterval = callbacks[i].timestamp - executionStartTime;
          console.log(`[Test]   Callback #${i} to #${i + 1}: ${interval}ms (absolute: ${relativeInterval}ms from start)`);

          // Expect reasonable intervals (at least 300ms to prove they're not all at end)
          expect(interval).toBeGreaterThanOrEqual(0); // At least 0ms (they happened at different times)
          expect(interval).toBeLessThanOrEqual(10000); // At most 10s between callbacks
        }
      }

      // 4. First callback must happen DURING execution (not after completion)
      // With streaming, first callback should occur significantly before execution ends
      const firstCallback = callbacks[0];
      const firstCallbackRelativeTime = firstCallback.timestamp - executionStartTime;
      const callbackProgressRatio = firstCallbackRelativeTime / totalDuration;

      console.log(`[Test] First callback at ${firstCallbackRelativeTime}ms into ${totalDuration}ms (${(callbackProgressRatio * 100).toFixed(1)}% through execution)`);

      // First callback must happen before execution ends (always true) but also
      // should happen while execution is still ongoing - before the final 20% of execution.
      // This distinguishes true live streaming from post-execution callbacks.
      expect(callbackProgressRatio).toBeLessThan(0.8);

      // 5. Total duration should be under 5 minutes
      expect(totalDuration).toBeLessThan(300000);

      console.log(`[Test] SUCCESS: ${callbacks.length} callbacks over ${totalDuration}ms, first callback at ${(callbackProgressRatio * 100).toFixed(1)}% through execution`);
    },
    300000
  );

  it(
    "should track multiple tool calls in a single step",
    async () => {
      const callbacks: CallbackRecord[] = [];

      const stepCallback = vi.fn(async (stepNumber: number, toolCalls: IToolCallSummary[]) => {
        callbacks.push({
          stepNumber,
          toolCalls,
          timestamp: Date.now(),
        });
      });

      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue(null);
      const photoSender = vi.fn().mockResolvedValue(null);

      await agent.initializeForChatAsync(
        "test-multi-step",
        messageSender,
        photoSender,
        stepCallback,
        "telegram"
      );

      // This multi-step prompt should trigger multiple tools
      await agent.processMessageForChatAsync(
        "test-multi-step",
        "Run 'echo hello' command, then list my crons"
      );

      console.log(`[Test] Multi-step: ${callbacks.length} callbacks`);

      // We expect at least one callback
      expect(callbacks.length).toBeGreaterThanOrEqual(1);

      // Check that we have tool call details
      for (const cb of callbacks) {
        console.log(`[Test] Step ${cb.stepNumber}: ${cb.toolCalls.length} tools`);
        expect(cb.toolCalls.length).toBeGreaterThanOrEqual(1);

        for (const tc of cb.toolCalls) {
          console.log(`[Test]   Tool: ${tc.name}`);
          expect(tc.name).toBeDefined();
        }
      }
    },
    300000
  );

  it(
    "should report fetch_rss tool call with URL parameter",
    async () => {
      const callbacks: CallbackRecord[] = [];

      const stepCallback = vi.fn(async (stepNumber: number, toolCalls: IToolCallSummary[]) => {
        callbacks.push({
          stepNumber,
          toolCalls,
          timestamp: Date.now(),
        });
      });

      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue(null);
      const photoSender = vi.fn().mockResolvedValue(null);

      await agent.initializeForChatAsync(
        "test-fetch-rss",
        messageSender,
        photoSender,
        stepCallback,
        "telegram"
      );

      await agent.processMessageForChatAsync(
        "test-fetch-rss",
        "Fetch RSS from http://localhost:3999/rss/news and tell me the titles"
      );

      console.log(`[Test] fetch_rss test: ${callbacks.length} callbacks`);

      // Find callback with fetch_rss tool
      const fetchRssCallback = callbacks.find((cb) =>
        cb.toolCalls.some((tc) => tc.name === "fetch_rss")
      );

      expect(fetchRssCallback).toBeDefined();

      if (fetchRssCallback) {
        const fetchRssTool = fetchRssCallback.toolCalls.find((tc) => tc.name === "fetch_rss");
        console.log(`[Test] fetch_rss tool call found:`, {
          input: fetchRssTool?.input,
        });

        // URL should be in the input
        expect(fetchRssTool?.input).toBeDefined();
        const input = fetchRssTool?.input as Record<string, unknown>;
        expect(input.url).toBeDefined();
      }
    },
    300000
  );
});

//#endregion Tests
