import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function snapshot(directory: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    result[name] = stat.isSymbolicLink()
      ? { link: await fs.readlink(file) }
      : stat.isDirectory()
        ? { mode: stat.mode & 0o777, contents: await snapshot(file) }
        : { mode: stat.mode & 0o777, content: (await fs.readFile(file)).toString("base64") };
  }
  return result;
}

it("does not let inherited runtime data paths bypass legacy test isolation", async () => {
  const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-parent-data-"));
  try {
    await fs.mkdir(path.join(sentinelDir, "prompts"));
    await fs.mkdir(path.join(sentinelDir, "databases"));
    await fs.writeFile(path.join(sentinelDir, "prompts", "main-agent.md"), "Preserve the operator's custom prompt.\n");
    await fs.writeFile(path.join(sentinelDir, "databases", "blackdog.db"), "Sentinel: tests must never open this database.\n");
    const original = await snapshot(sentinelDir);

    // These existing suites set HOME only. They would write prompts and SQLite
    // state into sentinelDir if the standard Vitest setup inherited this override.
    await execFileAsync(process.execPath, [
      path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "tests/integration/core/hot-reload.test.ts",
      "tests/integration/core/prompt-service.test.ts",
    ], {
      cwd: repoRoot,
      env: { ...process.env, BLACKDOGBOT_DATA_DIR: sentinelDir, NO_COLOR: "1" },
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });

    expect(await snapshot(sentinelDir)).toEqual(original);
  } finally {
    await fs.rm(sentinelDir, { recursive: true, force: true });
  }
}, 60_000);
