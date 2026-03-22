import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as litesql from "../../src/helpers/litesql.js";
import { buildCronToolContextBlockAsync } from "../../src/utils/cron-tool-context.js";

describe("buildCronToolContextBlockAsync", () => {
  it("uses dynamic write_table descriptions when table exists", async () => {
    const tempDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-cron-tool-context-"));
    const originalHome: string = process.env.HOME ?? os.homedir();

    try {
      process.env.HOME = tempDir;
      await fs.mkdir(path.join(tempDir, ".blackdogbot", "databases"), { recursive: true });

      await litesql.createDatabaseAsync("news");
      await litesql.createTableAsync("news", "articles", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
      ]);

      const contextBlock: string = await buildCronToolContextBlockAsync([
        "write_table_articles",
      ]);

      expect(contextBlock).toContain("write_table_articles");
      expect(contextBlock).toContain("Insert rows into the \"articles\" table in database \"news\"");
      expect(contextBlock).not.toContain("write_table_articles: (no description available)");
    } finally {
      process.env.HOME = originalHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to generic write_table description when table does not exist", async () => {
    const contextBlock: string = await buildCronToolContextBlockAsync([
      "write_table_nonexistent",
    ]);

    expect(contextBlock).toContain("write_table_nonexistent");
    expect(contextBlock).toContain("Insert rows into the 'nonexistent' table using validated column schemas.");
  });
});
