import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import type { IJob, INode, INodeProgressEvent, OnNodeProgressCallback } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;


async function initServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("error", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, path.join(tempConfigDir, "config.yaml"));
  await configService.initializeAsync(path.join(tempConfigDir, "config.yaml"));

  const aiProviderService: AiProviderService = AiProviderService.getInstance();
  aiProviderService.initialize(configService.getAiConfig());
}

async function buildReadyJobAsync(): Promise<{ job: IJob; startNode: INode; manualNode: INode }> {
  const storage: JobStorageService = JobStorageService.getInstance();

  const job: IJob = await storage.createJobAsync("Progress Test Job", "Tests node progress callbacks");

  const startNode: INode = await storage.addNodeAsync(
    job.jobId,
    "start",
    "Start",
    "Entry point — passes input through",
    {},
    { type: "object", properties: { value: { type: "number" } } },
    {},
  );

  const manualNode: INode = await storage.addNodeAsync(
    job.jobId,
    "start",
    "Double",
    "Doubles the incoming value",
    { type: "object", properties: { value: { type: "number" } } },
    { type: "object", properties: { result: { type: "number" } } },
    {},
  );

  await storage.updateNodeAsync(job.jobId, startNode.nodeId, { connections: [manualNode.nodeId] });
  await storage.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId, status: "ready" });

  return {
    job: (await storage.getJobAsync(job.jobId))!,
    startNode,
    manualNode,
  };
}


//#region Tests

describe("job execution progress callbacks (unit)", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-exec-progress-"));
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

  it("start node should pass input through to outputs without modification", async () => {
    const storage: JobStorageService = JobStorageService.getInstance();
    const job: IJob = await storage.createJobAsync("Start Passthrough", "Tests start node passthrough");

    const startNode: INode = await storage.addNodeAsync(
      job.jobId,
      "start",
      "Start",
      "Entry point",
      {},
      { type: "object", properties: { message: { type: "string" } } },
      {},
    );

    await storage.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId, status: "ready" });

    const executor: JobExecutorService = JobExecutorService.getInstance();
    const input: Record<string, unknown> = { message: "hello" };

    const result = await executor.executeJobAsync(job.jobId, input);

    expect(result.success).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({ message: "hello" }));
  });

  it("onNodeProgressAsync should emit executing then completed for each node", async () => {
    const { job, startNode, manualNode } = await buildReadyJobAsync();
    const executor: JobExecutorService = JobExecutorService.getInstance();

    const events: INodeProgressEvent[] = [];
    const onProgress: OnNodeProgressCallback = async (event: INodeProgressEvent): Promise<void> => {
      events.push({ ...event });
    };

    const result = await executor.executeJobAsync(job.jobId, { value: 5 }, onProgress);

    expect(result.success).toBe(true);

    const startExecuting: INodeProgressEvent | undefined = events.find(
      (e: INodeProgressEvent): boolean => e.nodeId === startNode.nodeId && e.status === "executing",
    );
    const startCompleted: INodeProgressEvent | undefined = events.find(
      (e: INodeProgressEvent): boolean => e.nodeId === startNode.nodeId && e.status === "completed",
    );
    const manualExecuting: INodeProgressEvent | undefined = events.find(
      (e: INodeProgressEvent): boolean => e.nodeId === manualNode.nodeId && e.status === "executing",
    );
    const manualCompleted: INodeProgressEvent | undefined = events.find(
      (e: INodeProgressEvent): boolean => e.nodeId === manualNode.nodeId && e.status === "completed",
    );

    expect(startExecuting).toBeDefined();
    expect(startCompleted).toBeDefined();
    expect(manualExecuting).toBeDefined();
    expect(manualCompleted).toBeDefined();
  });

  it("onNodeProgressAsync should emit executing then failed when a node fails", async () => {
    const storage: JobStorageService = JobStorageService.getInstance();
    const job: IJob = await storage.createJobAsync("Failing Progress", "Tests failure progress event");

    const startNode: INode = await storage.addNodeAsync(
      job.jobId,
      "start",
      "Start",
      "Entry",
      {},
      { type: "object", properties: { value: { type: "number" } } },
      {},
    );

    const pythonNode: INode = await storage.addNodeAsync(
      job.jobId,
      "python_code",
      "Crash",
      "Always crashes",
      { type: "object", properties: { value: { type: "number" } } },
      { type: "object", properties: { result: { type: "number" } } },
      {
        code: "raise ValueError('intentional error for test')",
        pythonPath: "python3",
        timeout: 5000,
      },
    );

    await storage.updateNodeAsync(job.jobId, startNode.nodeId, { connections: [pythonNode.nodeId] });
    await storage.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId, status: "ready" });

    const executor: JobExecutorService = JobExecutorService.getInstance();

    const events: INodeProgressEvent[] = [];
    const onProgress: OnNodeProgressCallback = async (event: INodeProgressEvent): Promise<void> => {
      events.push({ ...event });
    };

    const result = await executor.executeJobAsync(job.jobId, { value: 1 }, onProgress);

    expect(result.success).toBe(false);

    const crashExecuting: INodeProgressEvent | undefined = events.find(
      (e: INodeProgressEvent): boolean => e.nodeId === pythonNode.nodeId && e.status === "executing",
    );
    const crashFailed: INodeProgressEvent | undefined = events.find(
      (e: INodeProgressEvent): boolean => e.nodeId === pythonNode.nodeId && e.status === "failed",
    );

    expect(crashExecuting).toBeDefined();
    expect(crashFailed).toBeDefined();
  });

  it("onNodeProgressAsync callback errors should not abort the job execution", async () => {
    const { job } = await buildReadyJobAsync();
    const executor: JobExecutorService = JobExecutorService.getInstance();

    let callCount: number = 0;
    const throwingProgress: OnNodeProgressCallback = async (): Promise<void> => {
      callCount++;
      throw new Error("Callback error — should be swallowed");
    };

    const result = await executor.executeJobAsync(job.jobId, { value: 3 }, throwingProgress);

    expect(result.success).toBe(true);
    expect(callCount).toBeGreaterThan(0);
  });
});

//#endregion Tests
