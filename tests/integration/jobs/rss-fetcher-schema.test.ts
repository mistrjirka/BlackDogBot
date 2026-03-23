import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { JobActivityTracker } from "../../../src/utils/job-activity-tracker.js";
import { createAddRssFetcherNodeTool } from "../../../src/tools/add-rss-fetcher-node.tool.js";


let tempDir: string;
let originalHome: string;

const RssOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    link: { type: "string" },
    items: {
      type: "array",
      items: { type: "object" },
    },
    totalItems: { type: "number" },
    feedUrl: { type: "string" },
    mode: { type: "string" },
    unseenCount: { type: "number" },
  },
  required: ["items", "totalItems", "feedUrl", "mode"],
};


async function initServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("error", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
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


describe("rss_fetcher output schema (integration)", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-rss-schema-"));
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

  it("should default output schema to canonical RSS schema", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("Test Job", "desc");

    const tool = createAddRssFetcherNodeTool(new JobActivityTracker());
    const result = await execTool<{ success: boolean; nodeId: string; message: string }>(
      tool,
      {
        jobId: job.jobId,
        name: "Fetch RSS",
        description: "RSS feed node",
        url: "https://news.ycombinator.com/rss",
        mode: "latest",
        maxItems: 5,
      },
    );

    expect(result.success).toBe(true);

    const node = await storageService.getNodeAsync(job.jobId, result.nodeId);
    expect(node).toBeDefined();
    expect(node?.outputSchema).toEqual(RssOutputSchema);
  }, 600000);
});
