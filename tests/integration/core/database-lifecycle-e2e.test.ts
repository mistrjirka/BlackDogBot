import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
import type { IToolCallSummary } from "../../../src/agent/types.js";
import * as litesql from "../../../src/helpers/litesql.js";

const env = createTestEnvironment("db-lifecycle-e2e");

interface StepRecord {
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

describe("Database Lifecycle E2E (Real LLM)", () => {
  it(
    "should create database, create table, write, update, and verify via read",
    async () => {
      const chatId = `db-lifecycle-${Date.now()}`;
      const dbName = `lifecycle_test_db`;
      const tableName = `lifecycle_items`;
      const writeToolName = `write_table_${tableName}`;
      const updateToolName = `update_table_${tableName}`;

      const stepRecords: StepRecord[] = [];
      const stepCallback = vi.fn(async (stepNumber: number, toolCalls: IToolCallSummary[]) => {
        stepRecords.push({
          stepNumber,
          toolCalls,
          timestamp: Date.now(),
        });
        const toolNames = toolCalls.map(tc => tc.name).join(", ");
        console.log(`[Step ${stepNumber}] Tools called: ${toolNames}`);
        for (const tc of toolCalls) {
          console.log(`  -> ${tc.name}:`, JSON.stringify(tc.input, null, 2));
          if (tc.result) {
            console.log(`  <- Result:`, JSON.stringify(tc.result, null, 2).substring(0, 500));
          }
        }
      });

      const agent = LangchainMainAgent.getInstance();
      await agent.initializeAsync();

      const messageSender = vi.fn().mockResolvedValue(`msg-${chatId}`);
      const photoSender = vi.fn().mockResolvedValue(`photo-${chatId}`);

      await agent.initializeForChatAsync(chatId, messageSender, photoSender, stepCallback, "telegram");

      const prompt = [
        `We are going to test the full database lifecycle step by step.`,
        ``,
        `Step 1: Create a database named "${dbName}".`,
        `Step 2: Create a table named "${tableName}" in that database with these columns:`,
        `  - id INTEGER PRIMARY KEY AUTOINCREMENT`,
        `  - name TEXT NOT NULL`,
        `  - score INTEGER`,
        `  - created_at TEXT`,
        `Step 3: Insert exactly 2 rows using the ${writeToolName} tool:`,
        `  - Row 1: name="Alice", score=95, created_at="2026-01-01T00:00:00Z"`,
        `  - Row 2: name="Bob", score=72, created_at="2026-01-01T00:00:00Z"`,
        `Step 4: Update Bob's score to 88 using the ${updateToolName} tool with where="name = 'Bob'".`,
        `Step 5: Read all rows from the table using read_from_database and display them.`,
        ``,
        `IMPORTANT: After completing all steps, display a summary showing:`,
        `  - The database and table names`,
        `  - All rows currently in the table`,
        `  - Confirmation that Bob's score was updated from 72 to 88`,
        ``,
        `Do NOT use run_cmd or sqlite3. Use only the database tools listed above.`,
      ].join("\n");

      const result = await agent.processMessageForChatAsync(chatId, prompt);

      console.log("\n=== FINAL RESULT ===");
      console.log(result.text);
      console.log("=====================\n");

      const allToolNames = stepRecords.flatMap(r => r.toolCalls.map(tc => tc.name));

      expect(allToolNames).toContain("create_database");
      expect(allToolNames).toContain("create_table");
      expect(allToolNames).toContain(writeToolName);
      expect(allToolNames).toContain(updateToolName);
      expect(allToolNames).toContain("read_from_database");

      const readResult = await litesql.queryTableAsync(dbName, tableName);
      expect(readResult.rows).toHaveLength(2);

      const bobRow = readResult.rows.find((r: Record<string, unknown>) => r.name === "Bob");
      expect(bobRow).toBeDefined();
      expect(bobRow?.score).toBe(88);

      const aliceRow = readResult.rows.find((r: Record<string, unknown>) => r.name === "Alice");
      expect(aliceRow).toBeDefined();
      expect(aliceRow?.score).toBe(95);

      expect(result.text.toLowerCase()).toContain("alice");
      expect(result.text.toLowerCase()).toContain("bob");
      expect(result.stepsCount).toBeGreaterThanOrEqual(3);
    },
    600000,
  );
});
