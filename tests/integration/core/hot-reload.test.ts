import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as litesql from "../../../src/helpers/litesql.js";
import { ToolHotReloadService } from "../../../src/services/tool-hot-reload.service.js";

describe("ToolHotReloadService", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-reload-test-"));
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

  it("should include update_table_<name> tool after hot-reload", async () => {
    const chatId = "test-chat-hotreload";

    await litesql.createDatabaseAsync("blackdog");
    await litesql.createTableAsync("blackdog", "items", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "name", type: "TEXT", notNull: true },
    ]);

    const hotReload = ToolHotReloadService.getInstance();
    let receivedTools: any = null;

    hotReload.registerRebuildCallback(chatId, (tools) => {
      receivedTools = tools;
    });

    const triggered = await hotReload.triggerRebuildAsync(chatId);

    expect(triggered).toBe(true);
    expect(receivedTools).not.toBeNull();

    expect(receivedTools).toHaveProperty("write_table_items");
    expect(receivedTools).toHaveProperty("update_table_items");

    hotReload.unregisterRebuildCallback(chatId);
  });
});
