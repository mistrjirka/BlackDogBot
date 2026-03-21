import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolSet } from "ai";

import * as litesql from "../../src/helpers/litesql.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { createAgentNodeToolPool, getAgentNodeToolNamesAsync } from "../../src/utils/agent-node-tool-pool.js";
import { buildPerTableToolsAsync } from "../../src/utils/per-table-tools.js";

describe("agent-node-tool-pool", () => {
  it("includes per-table write tools when passed explicitly", async () => {
    const tempDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-agent-node-pool-"));
    const originalHome: string = process.env.HOME ?? os.homedir();

    try {
      process.env.HOME = tempDir;
      await fs.mkdir(path.join(tempDir, ".betterclaw", "databases"), { recursive: true });

      await litesql.createDatabaseAsync("jobs");
      await litesql.createTableAsync("jobs", "artifacts", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);

      const perTableTools: ToolSet = await buildPerTableToolsAsync();
      const pool = createAgentNodeToolPool(LoggerService.getInstance(), undefined, perTableTools);

      expect(pool).toHaveProperty("write_table_artifacts");
    } finally {
      process.env.HOME = originalHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("getAgentNodeToolNamesAsync includes dynamic write_table tool names", async () => {
    const tempDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-agent-node-names-"));
    const originalHome: string = process.env.HOME ?? os.homedir();

    try {
      process.env.HOME = tempDir;
      await fs.mkdir(path.join(tempDir, ".betterclaw", "databases"), { recursive: true });

      await litesql.createDatabaseAsync("jobs");
      await litesql.createTableAsync("jobs", "results", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "value", type: "TEXT", notNull: true },
      ]);

      const toolNames: string[] = await getAgentNodeToolNamesAsync();
      expect(toolNames).toContain("write_table_results");
    } finally {
      process.env.HOME = originalHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
