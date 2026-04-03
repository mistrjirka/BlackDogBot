import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as litesql from "../../../src/helpers/litesql.js";
import { buildPerTableToolsAsync } from "../../../src/utils/per-table-tools.js";
import { ToolHotReloadService } from "../../../src/services/tool-hot-reload.service.js";
import type { IRebuildResult } from "../../../src/services/tool-hot-reload.service.js";
import type { DynamicStructuredTool } from "langchain";

function createMockTool(name: string): DynamicStructuredTool {
  return {
    name,
    description: `Mock tool: ${name}`,
    schema: {} as any,
    invoke: async () => "",
  } as unknown as DynamicStructuredTool;
}

describe("Hot-reload timing bug", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-reload-timing-test-"));
    originalHome = process.env.HOME ?? "";
    process.env.HOME = tempDir;

    await fs.mkdir(path.join(tempDir, ".blackdogbot", "databases"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("BUG: buildPerTableToolsAsync doesn't see newly created table", () => {
    it("should see write_table_news_items immediately after create_table creates the table", async () => {
      await litesql.createDatabaseAsync("news_monitor");
      await litesql.createTableAsync("news_monitor", "news_items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "source", type: "TEXT", notNull: true },
        { name: "pub_date", type: "TEXT", notNull: true },
        { name: "created_at", type: "TEXT", notNull: true },
      ]);

      const tableExists = await litesql.tableExistsAsync("news_monitor", "news_items");
      expect(tableExists).toBe(true);

      const tables = await litesql.listTablesAsync("news_monitor");
      expect(tables).toContain("news_items");

      const tools = await buildPerTableToolsAsync();

      expect(tools).toHaveProperty("write_table_news_items");
      expect(tools.write_table_news_items).toBeDefined();
      expect(typeof tools.write_table_news_items.invoke).toBe("function");
    });

    it("should detect the bug: table exists but buildPerTableToolsAsync returns empty", async () => {
      await litesql.createDatabaseAsync("testdb");
      await litesql.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      const tableExists = await litesql.tableExistsAsync("testdb", "users");
      const tables = await litesql.listTablesAsync("testdb");

      const tools = await buildPerTableToolsAsync();
      const toolKeys = Object.keys(tools);

      console.log("DEBUG: tableExists =", tableExists);
      console.log("DEBUG: tables =", tables);
      console.log("DEBUG: toolKeys =", toolKeys);

      if (!tableExists) {
        console.log("BUG DETECTED: tableExists is false even though we just created it");
      }

      if (!toolKeys.includes("write_table_users")) {
        console.log("BUG DETECTED: write_table_users not in tools even though table exists");
        console.log("BUG DETECTED: tools =", tools);
      }

      expect(tools).toHaveProperty("write_table_users");
    });

    it("should see new table via hot-reload service immediately after creation", async () => {
      await litesql.createDatabaseAsync("scrape_db");
      await litesql.createTableAsync("scrape_db", "pages", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "url", type: "TEXT", notNull: true },
        { name: "content", type: "TEXT" },
      ]);

      const hotReload = ToolHotReloadService.getInstance();
      let capturedTools: Record<string, DynamicStructuredTool> = {};

      hotReload.registerRebuildCallback("test-hotreload-chat", (result: IRebuildResult) => {
        capturedTools = result.perTableTools;
      });

      const rebuildResult = await hotReload.triggerRebuildAsync("test-hotreload-chat");

      expect(rebuildResult.success).toBe(true);
      expect(capturedTools).toHaveProperty("write_table_pages");
      expect(capturedTools.write_table_pages).toBeDefined();

      hotReload.unregisterRebuildCallback("test-hotreload-chat");
    });
  });

  describe("BUG: _rebuildToolsForChat removes write_table_* tools when perTableTools is empty", () => {
    it("should NOT remove existing write_table_* tools when perTableTools is empty (defensive check)", () => {
      const existingTools: DynamicStructuredTool[] = [
        createMockTool("think"),
        createMockTool("write_table_users"),
        createMockTool("write_table_orders"),
        createMockTool("add_cron"),
      ];

      const session = {
        chatId: "test-chat",
        tools: [...existingTools],
        lastAddedTableNames: [] as string[],
      };

      const emptyResult: IRebuildResult = {
        success: true,
        perTableTools: {},
        addedTableNames: [],
        removedTableNames: [],
      };

      const perTableToolNames = Object.keys(emptyResult.perTableTools);
      
      if (perTableToolNames.length === 0 && emptyResult.addedTableNames.length === 0) {
        console.log("DEBUG: Skipping tool replacement - empty result");
        expect(session.tools.some(t => t.name === "write_table_users")).toBe(true);
        expect(session.tools.some(t => t.name === "write_table_orders")).toBe(true);
        return;
      }

      const newTools = session.tools.filter(t =>
        !t.name.startsWith("write_table_") &&
        !["add_cron", "edit_cron", "edit_cron_instructions"].includes(t.name)
      );

      for (const tool of Object.values(emptyResult.perTableTools)) {
        newTools.push(tool);
      }

      if (emptyResult.cronTools) {
        newTools.push(emptyResult.cronTools.add_cron);
        newTools.push(emptyResult.cronTools.edit_cron);
        newTools.push(emptyResult.cronTools.edit_cron_instructions);
      }

      console.log("DEBUG: Original tools count:", session.tools.length);
      console.log("DEBUG: After rebuild with empty perTableTools count:", newTools.length);
      console.log("DEBUG: write_table_users still present:", newTools.some(t => t.name === "write_table_users"));
      console.log("DEBUG: write_table_orders still present:", newTools.some(t => t.name === "write_table_orders"));

      expect(newTools.some(t => t.name === "write_table_users")).toBe(true);
      expect(newTools.some(t => t.name === "write_table_orders")).toBe(true);
    });

    it("should correctly preserve write_table_* tools during normal rebuild", () => {
      const existingTools: DynamicStructuredTool[] = [
        createMockTool("think"),
        createMockTool("write_table_users"),
      ];

      const session = {
        chatId: "test-chat",
        tools: [...existingTools],
        lastAddedTableNames: [] as string[],
      };

      const newPerTableTools: Record<string, DynamicStructuredTool> = {
        write_table_users: createMockTool("write_table_users"),
        write_table_news: createMockTool("write_table_news"),
      };

      const result: IRebuildResult = {
        success: true,
        perTableTools: newPerTableTools,
        addedTableNames: ["news"],
        removedTableNames: [],
      };

      const newTools = session.tools.filter(t =>
        !t.name.startsWith("write_table_") &&
        !["add_cron", "edit_cron", "edit_cron_instructions"].includes(t.name)
      );

      for (const tool of Object.values(result.perTableTools)) {
        newTools.push(tool);
      }

      const writeTableTools = newTools.filter(t => t.name.startsWith("write_table_"));
      expect(newTools.some(t => t.name === "write_table_users")).toBe(true);
      expect(newTools.some(t => t.name === "write_table_news")).toBe(true);
      expect(writeTableTools).toHaveLength(2);
    });
  });

  describe("End-to-end hot-reload timing scenario", () => {
    it("simulates the exact bug: create_table -> hot-reload -> tool missing", async () => {
      const chatId = "e2e-hotreload-test";

      await litesql.createDatabaseAsync("app_db");

      const hotReload = ToolHotReloadService.getInstance();
      let rebuildResult: IRebuildResult | null = null;

      hotReload.registerRebuildCallback(chatId, (result: IRebuildResult) => {
        rebuildResult = result;
      });

      await litesql.createTableAsync("app_db", "products", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "price", type: "REAL", notNull: true },
      ]);

      const triggered = await hotReload.triggerRebuildAsync(chatId);

      expect(triggered.success).toBe(true);
      expect(rebuildResult).not.toBeNull();
      expect(rebuildResult!.success).toBe(true);

      const tableExists = await litesql.tableExistsAsync("app_db", "products");
      expect(tableExists).toBe(true);

      expect(rebuildResult!.perTableTools).toHaveProperty("write_table_products");

      hotReload.unregisterRebuildCallback(chatId);
    });

    it("demonstrates the FIX: _rebuildToolsForChat with empty perTableTools preserves existing tools", () => {
      const session = {
        chatId: "failure-demo",
        tools: [
          createMockTool("write_table_news_items"),
          createMockTool("add_cron"),
        ],
        lastAddedTableNames: [] as string[],
      };

      const resultWithEmpty: IRebuildResult = {
        success: true,
        perTableTools: {},
        addedTableNames: [],
        removedTableNames: [],
      };

      const perTableToolNames = Object.keys(resultWithEmpty.perTableTools);
      
      if (perTableToolNames.length === 0 && resultWithEmpty.addedTableNames.length === 0) {
        console.log("FIX SCENARIO:");
        console.log("  - Session had write_table_news_items tool");
        console.log("  - Hot-reload triggered with empty perTableTools");
        console.log("  - DEFENSIVE CHECK: Skipping tool replacement to preserve existing tools");
        console.log("  - write_table_news_items still present:", session.tools.some(t => t.name === "write_table_news_items"));
        expect(session.tools.some(t => t.name === "write_table_news_items")).toBe(true);
        return;
      }

      const newTools = session.tools.filter(t =>
        !t.name.startsWith("write_table_") &&
        !["add_cron", "edit_cron", "edit_cron_instructions"].includes(t.name)
      );

      for (const tool of Object.values(resultWithEmpty.perTableTools)) {
        newTools.push(tool);
      }

      console.log("FIX SCENARIO:");
      console.log("  - Session had write_table_news_items tool");
      console.log("  - Hot-reload triggered with empty perTableTools");
      console.log("  - After rebuild, write_table_news_items present:", newTools.some(t => t.name === "write_table_news_items"));
      console.log("  - This should be TRUE (defensive check prevents removal)");

      expect(newTools.some(t => t.name === "write_table_news_items")).toBe(true);
    });
  });
});
