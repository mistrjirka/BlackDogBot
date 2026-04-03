import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { z } from "zod";

import { createTestEnvironment, resetSingletons, loadTestConfigAsync } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import { McpRegistryService } from "../../../src/services/mcp-registry.service.js";
import { LangchainMcpService } from "../../../src/services/langchain-mcp.service.js";
import { buildCronToolsAsync } from "../../../src/tools/build-cron-tools.js";
import { buildPerTableToolsAsync } from "../../../src/utils/per-table-tools.js";
import { validateCronToolNames } from "../../../src/helpers/cron-validation.js";
import * as litesql from "../../../src/helpers/litesql.js";

const env = createTestEnvironment("hot-reload-cron-tools");

describe("Hot Reload Cron Tools Integration", () => {
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

  describe("dynamic tool schema validation", () => {
    it("should accept dynamic write_table tool name in cron tools schema after table creation", async () => {
      const suffix = Date.now().toString().slice(-6);
      const databaseName = `hotreload_cron_db_${suffix}`;
      const tableName = `items_${suffix}`;
      const writeToolName = `write_table_${tableName}`;

      await litesql.createDatabaseAsync(databaseName);
      await litesql.createTableAsync(databaseName, tableName, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "created_at", type: "TEXT", notNull: true },
      ]);

      const perTableTools = await buildPerTableToolsAsync();
      expect(perTableTools[writeToolName]).toBeDefined();

      const cronTools = await buildCronToolsAsync();
      expect(cronTools.add_cron).toBeDefined();

      const addCronInput = {
        name: `test-cron-${suffix}`,
        description: "Test cron with dynamic tool",
        instructions: `Insert data into ${tableName}`,
        tools: [writeToolName],
        scheduleType: "interval" as const,
        scheduleIntervalMs: 3600000,
        notifyUser: false,
      };

      const parsed = await (cronTools.add_cron.schema as z.ZodObject<any>).parseAsync(addCronInput);
      expect(parsed.tools).toContain(writeToolName);
    });

    it("should validate dynamic tool names via validateCronToolNames after hot-reload", async () => {
      const suffix = Date.now().toString().slice(-6);
      const databaseName = `validation_db_${suffix}`;
      const tableName = `tasks_${suffix}`;
      const writeToolName = `write_table_${tableName}`;

      await litesql.createDatabaseAsync(databaseName);
      await litesql.createTableAsync(databaseName, tableName, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      await buildPerTableToolsAsync();

      const invalidTools = validateCronToolNames([writeToolName]);
      expect(invalidTools).toHaveLength(0);

      const invalidToolsWithBad = validateCronToolNames([writeToolName, "nonexistent_tool"]);
      expect(invalidToolsWithBad).toContain("nonexistent_tool");
    });

    it("should rebuild cron tools with new dynamic tool after table creation", async () => {
      const suffix = Date.now().toString().slice(-6);
      const databaseName = `rebuild_db_${suffix}`;
      const tableName1 = `table1_${suffix}`;
      const tableName2 = `table2_${suffix}`;
      const writeTool1 = `write_table_${tableName1}`;
      const writeTool2 = `write_table_${tableName2}`;

      await litesql.createDatabaseAsync(databaseName);
      await litesql.createTableAsync(databaseName, tableName1, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "data", type: "TEXT", notNull: true },
      ]);

      const perTableTools1 = await buildPerTableToolsAsync();
      expect(perTableTools1[writeTool1]).toBeDefined();
      expect(perTableTools1[writeTool2]).toBeUndefined();

      await litesql.createTableAsync(databaseName, tableName2, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "value", type: "INTEGER", notNull: true },
      ]);

      const perTableTools2 = await buildPerTableToolsAsync();
      expect(perTableTools2[writeTool1]).toBeDefined();
      expect(perTableTools2[writeTool2]).toBeDefined();

      const cronTools = await buildCronToolsAsync();

      const input1 = {
        name: `cron1-${suffix}`,
        description: "First cron",
        instructions: "Insert into table1",
        tools: [writeTool1],
        scheduleType: "interval" as const,
        scheduleIntervalMs: 7200000,
        notifyUser: false,
      };

      const input2 = {
        name: `cron2-${suffix}`,
        description: "Second cron",
        instructions: "Insert into table2",
        tools: [writeTool2, "think"],
        scheduleType: "interval" as const,
        scheduleIntervalMs: 3600000,
        notifyUser: true,
      };

      const parsed1 = await (cronTools.add_cron.schema as z.ZodObject<any>).parseAsync(input1);
      expect(parsed1.tools).toContain(writeTool1);

      const parsed2 = await (cronTools.add_cron.schema as z.ZodObject<any>).parseAsync(input2);
      expect(parsed2.tools).toContain(writeTool2);
      expect(parsed2.tools).toContain("think");
    });

    it("should reject invalid tool names in cron tools schema", async () => {
      const cronTools = await buildCronToolsAsync();

      const invalidInput = {
        name: "invalid-cron",
        description: "Cron with invalid tool",
        instructions: "Do something",
        tools: ["write_table_nonexistent", "think"],
        scheduleType: "interval" as const,
        scheduleIntervalMs: 3600000,
        notifyUser: false,
      };

      await expect((cronTools.add_cron.schema as z.ZodObject<any>).parseAsync(invalidInput)).rejects.toThrow();
    });

    it("should handle multiple write_table tools in same cron tools enum", async () => {
      const suffix = Date.now().toString().slice(-6);
      const databaseName = `multi_db_${suffix}`;
      const tableName1 = `tbl_a_${suffix}`;
      const tableName2 = `tbl_b_${suffix}`;
      const writeTool1 = `write_table_${tableName1}`;
      const writeTool2 = `write_table_${tableName2}`;

      await litesql.createDatabaseAsync(databaseName);
      await litesql.createTableAsync(databaseName, tableName1, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "col_a", type: "TEXT", notNull: true },
      ]);
      await litesql.createTableAsync(databaseName, tableName2, [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "col_b", type: "TEXT", notNull: true },
      ]);

      await buildPerTableToolsAsync();

      const cronTools = await buildCronToolsAsync();

      const input = {
        name: `multi-cron-${suffix}`,
        description: "Cron with multiple dynamic tools",
        instructions: "Insert into both tables",
        tools: [writeTool1, writeTool2, "send_message"],
        scheduleType: "interval" as const,
        scheduleIntervalMs: 7200000,
        notifyUser: true,
      };

      const parsed = await (cronTools.add_cron.schema as z.ZodObject<any>).parseAsync(input);
      expect(parsed.tools).toContain(writeTool1);
      expect(parsed.tools).toContain(writeTool2);
      expect(parsed.tools).toContain("send_message");
    });
  });
});
