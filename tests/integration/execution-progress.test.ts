import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../src/services/logger.service.js";
import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { JobStorageService } from "../../src/services/job-storage.service.js";
import { JobExecutorService } from "../../src/services/job-executor.service.js";
import { RssStateService } from "../../src/services/rss-state.service.js";
import { LiteSqlService } from "../../src/services/litesql.service.js";
import type { IJob, INode, INodeProgressEvent, OnNodeProgressCallback } from "../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
  (JobExecutorService as unknown as { _instance: null })._instance = null;
  (RssStateService as unknown as { _instance: null })._instance = null;
  (LiteSqlService as unknown as { _instance: null })._instance = null;
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

  const aiProviderService: AiProviderService = AiProviderService.getInstance();
  aiProviderService.initialize(configService.getAiConfig());
}

/**
 * Build a minimal two-node job (start → manual) that is "ready" for execution.
 * The start node passes input through directly; the manual node re-emits it.
 */
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

  // Connect start → manual
  await storage.updateNodeAsync(job.jobId, startNode.nodeId, { connections: [manualNode.nodeId] });
  // Set entrypoint
  await storage.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId, status: "ready" });

  return {
    job: (await storage.getJobAsync(job.jobId))!,
    startNode,
    manualNode,
  };
}

//#endregion Helpers

//#region Tests

describe("job execution progress callbacks (unit)", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-exec-progress-"));
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
    // Arrange
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

    // Act
    const result = await executor.executeJobAsync(job.jobId, input);

    // Assert — start node must pass input straight through
    expect(result.success).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({ message: "hello" }));
  });

  it("onNodeProgressAsync should emit executing then completed for each node", async () => {
    // Arrange
    const { job, startNode, manualNode } = await buildReadyJobAsync();
    const executor: JobExecutorService = JobExecutorService.getInstance();

    const events: INodeProgressEvent[] = [];
    const onProgress: OnNodeProgressCallback = async (event: INodeProgressEvent): Promise<void> => {
      events.push({ ...event });
    };

    // Act
    const result = await executor.executeJobAsync(job.jobId, { value: 5 }, onProgress);

    // Assert — execution succeeded
    expect(result.success).toBe(true);

    // Each node should produce an "executing" event followed by a "completed" event
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
    // Arrange — create a job with a start node that references invalid Python code
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

    // A python_code node that intentionally raises an error
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

    // Act
    const result = await executor.executeJobAsync(job.jobId, { value: 1 }, onProgress);

    // Assert — execution should fail
    expect(result.success).toBe(false);

    // The python node should have had "executing" followed by "failed"
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
    // Arrange
    const { job } = await buildReadyJobAsync();
    const executor: JobExecutorService = JobExecutorService.getInstance();

    let callCount: number = 0;
    const throwingProgress: OnNodeProgressCallback = async (): Promise<void> => {
      callCount++;
      throw new Error("Callback error — should be swallowed");
    };

    // Act — should NOT throw despite the callback throwing
    const result = await executor.executeJobAsync(job.jobId, { value: 3 }, throwingProgress);

    // Assert — job completed despite callback errors
    expect(result.success).toBe(true);
    // Callback was still called (errors were swallowed, not skipped)
    expect(callCount).toBeGreaterThan(0);
  });
});

//#endregion Tests
