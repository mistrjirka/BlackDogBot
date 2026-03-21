import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { JobActivityTracker } from "../../../src/utils/job-activity-tracker.js";
import { createAddPythonCodeNodeTool } from "../../../src/tools/add-python-code-node.tool.js";


let tempDir: string;
let originalHome: string;


async function initServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("error", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".betterclaw");
  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, path.join(tempConfigDir, "config.yaml"));
  await configService.initializeAsync(path.join(tempConfigDir, "config.yaml"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execTool<T>(toolObj: any, args: unknown): Promise<T> {
  if (!toolObj.execute) {
    throw new Error("Tool has no execute function");
  }

  const result = await toolObj.execute(
    args,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );

  return result as T;
}


describe("add_python_code_node (unit)", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-add-python-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();
    await initServicesAsync();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should reject sqlite imports in python code", async () => {
    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("Test Job", "desc");

    const tool = createAddPythonCodeNodeTool(new JobActivityTracker());

    const result = await execTool<{ success: boolean; message: string; error?: string }>(
      tool,
      {
        jobId: job.jobId,
        name: "Bad Python",
        description: "Uses sqlite",
        outputSchema: { type: "object", fields: [{ name: "ok", type: "boolean" }] },
        code: "import sqlite3\nconn = sqlite3.connect(':memory:')",
        pythonPath: "python3",
        timeout: 1000,
      },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/sqlite/i);
    expect(result.message).toMatch(/create_table/i);
    expect(result.message).toMatch(/write_table_/i);
    expect(result.message).toMatch(/read_from_database/i);
  });
});
