import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { createStartJobCreationTool } from "../../../src/tools/start-job-creation.tool.js";
import { createFinishJobCreationTool } from "../../../src/tools/finish-job-creation.tool.js";
import { JobActivityTracker } from "../../../src/utils/job-activity-tracker.js";
import type { IJobCreationMode, IJobCreationModeTracker } from "../../../src/utils/job-creation-mode-tracker.js";


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
}

function makeCreationModeTracker(): IJobCreationModeTracker & { _mode: IJobCreationMode | null } {
  const tracker = {
    _mode: null as IJobCreationMode | null,
    setMode(jobId: string, startNodeId: string): void {
      tracker._mode = { jobId, startNodeId, auditAttempted: false };
    },
    clearMode(): void {
      tracker._mode = null;
    },
    getMode(): IJobCreationMode | null {
      return tracker._mode;
    },
    markAuditAttempted(): void {
      if (tracker._mode) {
        tracker._mode.auditAttempted = true;
      }
    },
  };

  return tracker;
}

/** Invoke a tool's execute function, bypassing strict input typing for testing. */
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


//#region Tests

describe("job creation mode tools (unit)", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-creation-mode-"));
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

  it("start_job_creation should return an error if already in creation mode (double-call guard)", async () => {
    // Arrange — tracker already has an active mode
    const tracker: IJobCreationModeTracker = makeCreationModeTracker();
    tracker.setMode("existing-job-id", "existing-start-node");

    const startTool = createStartJobCreationTool(new JobActivityTracker(), tracker);

    // Act
    const result = await execTool<{ jobId: string; startNodeId: string; message: string; error?: string }>(
      startTool,
      { name: "New Job", description: "desc", startNodeDescription: "start" },
    );

    // Assert — must refuse because mode is already active
    expect(result.error).toBeDefined();
    expect(result.jobId).toBe("");
    expect(result.startNodeId).toBe("");
    expect(result.message).toMatch(/already in job creation mode/i);
  });

  it("start_job_creation should activate creation mode on success", async () => {
    // Arrange
    const tracker = makeCreationModeTracker();
    const startTool = createStartJobCreationTool(new JobActivityTracker(), tracker);

    // Act
    const result = await execTool<{ jobId: string; startNodeId: string; message: string; error?: string }>(
      startTool,
      { name: "My Job", description: "A test job", startNodeDescription: "Entry point" },
    );

    // Assert — mode should be active
    expect(result.error).toBeUndefined();
    expect(result.jobId).toBeTruthy();
    expect(result.startNodeId).toBeTruthy();
    expect(tracker.getMode()).not.toBeNull();
    expect(tracker.getMode()?.jobId).toBe(result.jobId);
  });

  it("finish_job_creation should return an error if not in creation mode", async () => {
    // Arrange — create a job but do NOT set mode
    const tracker: IJobCreationModeTracker = makeCreationModeTracker();
    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("Test Job", "desc");
    const finishTool = createFinishJobCreationTool(tracker);

    // Act
    const result = await execTool<{ success: boolean; message: string; validationErrors: string[] }>(
      finishTool,
      { jobId: job.jobId },
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not currently in job creation mode/i);
  });

  it("finish_job_creation should return an error if jobId does not match active mode", async () => {
    // Arrange — set mode for a different job
    const tracker: IJobCreationModeTracker = makeCreationModeTracker();
    tracker.setMode("some-other-job-id", "some-start-node");

    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("Another Job", "desc");
    const finishTool = createFinishJobCreationTool(tracker);

    // Act
    const result = await execTool<{ success: boolean; message: string; validationErrors: string[] }>(
      finishTool,
      { jobId: job.jobId },
    );

    // Assert — must reject the mismatched jobId
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/active creation mode is for job/i);
  });

  it("finish_job_creation should succeed without LLM audit (audit currently disabled)", async () => {
    // Arrange — create a job with a start node and set creation mode
    const tracker = makeCreationModeTracker();
    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("Audit Test Job", "Testing with disabled audit");
    const startNode = await storage.addNodeAsync(
      job.jobId,
      "start",
      "Start",
      "Entry point",
      {},
      { type: "object", properties: { input: { type: "string" } } },
      { scheduledTaskId: null },
    );
    await storage.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId });
    tracker.setMode(job.jobId, startNode.nodeId);

    const finishTool = createFinishJobCreationTool(tracker);

    // Act — with audit disabled, skipAudit value is irrelevant
    const result = await execTool<{ success: boolean; message: string; validationErrors: string[] }>(
      finishTool,
      { jobId: job.jobId, skipAudit: false },
    );

    // Assert — should succeed since audit is disabled
    expect(result.success).toBe(true);
    expect(result.message).toContain("ready for execution");
  });

  it("finish_job_creation should succeed with skipAudit=true after mode tracker has audit attempted", async () => {
    // Arrange — create a job and simulate first audit attempt
    const tracker = makeCreationModeTracker();
    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("Skip Audit Test Job", "Testing skipAudit after first attempt");
    const startNode = await storage.addNodeAsync(
      job.jobId,
      "start",
      "Start",
      "Entry point",
      {},
      { type: "object", properties: { input: { type: "string" } } },
      { scheduledTaskId: null },
    );
    await storage.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId });
    tracker.setMode(job.jobId, startNode.nodeId);

    // Mark that an audit was already attempted
    tracker.markAuditAttempted();

    const finishTool = createFinishJobCreationTool(tracker);

    // Act — call with skipAudit=true AFTER first audit attempt
    const result = await execTool<{ success: boolean; message: string; validationErrors: string[] }>(
      finishTool,
      { jobId: job.jobId, skipAudit: true },
    );

    // Assert — should succeed without running audit
    // (assuming all other validations pass)
    expect(result.success).toBe(true);
    expect(result.message).toContain("ready for execution");
  });
});

//#endregion Tests
