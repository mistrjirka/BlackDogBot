import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../src/services/logger.service.js";
import { ConfigService } from "../../src/services/config.service.js";
import { JobStorageService } from "../../src/services/job-storage.service.js";
import { JobActivityTracker } from "../../src/utils/job-activity-tracker.js";
import { getAgentNodeToolNames } from "../../src/utils/agent-node-tool-pool.js";
import { createAddAgentNodeTool } from "../../src/tools/add-agent-node.tool.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (ConfigService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
}

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

//#endregion Helpers

describe("add_agent_node (unit)", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-add-agent-"));
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

  it("should reject agent node with no selected tools", async () => {
    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("Test Job", "desc");

    const tool = createAddAgentNodeTool(new JobActivityTracker());

    const result = await execTool<{ success: boolean; message: string; error?: string }>(
      tool,
      {
        jobId: job.jobId,
        name: "Agent Without Tools",
        description: "No tools selected",
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        systemPrompt: "Do something",
        selectedTools: [],
        model: null,
        reasoningEffort: null,
        maxSteps: 10,
      },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/doesn't have any tools/i);
    expect(result.message).toMatch(/available tools/i);
    expect(result.message).toContain(getAgentNodeToolNames().join(", "));
  });
});
