import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { JobExecutorService } from "../../../src/services/job-executor.service.js";
import type { IJob, INode, IJobExecutionResult } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;


async function writeConfigAsync(configPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, "utf-8");
}


describe("job-completion-event", () => {
  const storageService: JobStorageService = JobStorageService.getInstance();
  const executorService: JobExecutorService = JobExecutorService.getInstance();
  let jobId: string;
  let nodeId: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-job-completion-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const configPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });

    const realConfigContent: string = await fs.readFile(realConfigPath, "utf-8");

    let configWithServices: string = realConfigContent;

    if (!realConfigContent.includes("services:")) {
      const servicesSection: string = `\nservices:\n  searxngUrl: http://localhost:18731\n  crawl4aiUrl: http://localhost:18732\n`;
      configWithServices = realConfigContent + servicesSection;
    }

    await writeConfigAsync(configPath, configWithServices);

    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();

    await configService.initializeAsync(configPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();

    aiProviderService.initialize(configService.getAiConfig());

    const job: IJob = await storageService.createJobAsync(
      "Test Job Completion",
      "Test job for completion events",
    );

    jobId = job.jobId;

    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: { message: { type: "string" } },
    };
    const outputSchema: Record<string, unknown> = {
      type: "object",
      properties: { message: { type: "string" } },
    };

    const node: INode = await storageService.addNodeAsync(
      jobId,
      "start",
      "Start Node",
      "Entry point",
      inputSchema,
      outputSchema,
      {},
    );

    nodeId = node.nodeId;

    await storageService.updateJobAsync(jobId, {
      entrypointNodeId: nodeId,
      status: "ready",
    });
  });

  afterAll(async () => {
    await storageService.deleteJobAsync(jobId);
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await storageService.updateJobAsync(jobId, { status: "ready" });
  });

  it("should return timing info on successful job execution", async () => {
    const result: IJobExecutionResult = await executorService.executeJobAsync(jobId, { message: "test" });

    expect(result.success).toBe(true);
    expect(result.timing).toBeDefined();
    expect(result.timing!.startedAt).toBeDefined();
    expect(result.timing!.completedAt).toBeDefined();
    expect(result.timing!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timing!.completedAt).toBeGreaterThanOrEqual(result.timing!.startedAt);
  });

  it("should return node results on successful job execution", async () => {
    const result: IJobExecutionResult = await executorService.executeJobAsync(jobId, { message: "test" });

    expect(result.success).toBe(true);
    expect(result.nodeResults).toBeDefined();
    expect(result.nodeResults!.length).toBe(1);
    expect(result.nodeResults![0].nodeId).toBe(nodeId);
    expect(result.nodeResults![0].nodeName).toBe("Start Node");
    expect(result.nodeResults![0].duration).toBeGreaterThanOrEqual(0);
  });

  it("should return timing info on failed job execution", async () => {
    const failJob: IJob = await storageService.createJobAsync(
      "Test Failing Job",
      "Test job that fails",
    );

    const failNode: INode = await storageService.addNodeAsync(
      failJob.jobId,
      "python_code",
      "Failing Node",
      "This node will fail",
      { type: "object", properties: {} },
      { type: "object", properties: {} },
      {
        code: "raise Exception('Intentional failure for testing')",
        pythonPath: "python3",
        timeout: 30000,
      },
    );

    await storageService.updateJobAsync(failJob.jobId, {
      entrypointNodeId: failNode.nodeId,
      status: "ready",
    });

    const result: IJobExecutionResult = await executorService.executeJobAsync(failJob.jobId, {});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.timing).toBeDefined();
    expect(result.timing!.durationMs).toBeGreaterThanOrEqual(0);

    await storageService.deleteJobAsync(failJob.jobId);
  });

  it("should track nodesExecuted count correctly", async () => {
    const result: IJobExecutionResult = await executorService.executeJobAsync(jobId, { message: "test" });

    expect(result.success).toBe(true);
    expect(result.nodesExecuted).toBe(1);
    expect(result.nodeResults!.length).toBe(result.nodesExecuted);
  });
});
