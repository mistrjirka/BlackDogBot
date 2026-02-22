import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../src/services/logger.service.js";
import { JobStorageService } from "../../src/services/job-storage.service.js";
import type { IJob, INode } from "../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
}

async function createJobWithNodeChain(
  storageService: JobStorageService,
): Promise<{
  job: IJob;
  nodeA: INode;
  nodeB: INode;
  nodeC: INode;
}> {
  const job: IJob = await storageService.createJobAsync(
    "Remove Node Cleanup Job",
    "Job for testing node deletion cleanup",
  );

  const nodeA: INode = await storageService.addNodeAsync(
    job.jobId,
    "start",
    "Node A",
    "First node",
    {},
    {},
    { scheduledTaskId: null },
  );

  const nodeB: INode = await storageService.addNodeAsync(
    job.jobId,
    "start",
    "Node B",
    "Second node",
    {},
    {},
    { scheduledTaskId: null },
  );

  const nodeC: INode = await storageService.addNodeAsync(
    job.jobId,
    "start",
    "Node C",
    "Third node",
    {},
    {},
    { scheduledTaskId: null },
  );

  return { job, nodeA, nodeB, nodeC };
}

//#endregion Helpers

//#region Tests

describe("remove node cleanup", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-remove-node-cleanup-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    await fs.mkdir(tempConfigDir, { recursive: true });

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should remove deleted node from other nodes' connections", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const { job, nodeA, nodeB, nodeC } = await createJobWithNodeChain(storageService);

    await storageService.updateNodeAsync(job.jobId, nodeA.nodeId, {
      connections: [nodeB.nodeId],
    });

    await storageService.updateNodeAsync(job.jobId, nodeB.nodeId, {
      connections: [nodeC.nodeId],
    });

    await storageService.deleteNodeAsync(job.jobId, nodeB.nodeId);

    const updatedNodeA: INode | null = await storageService.getNodeAsync(job.jobId, nodeA.nodeId);
    const updatedNodeC: INode | null = await storageService.getNodeAsync(job.jobId, nodeC.nodeId);

    expect(updatedNodeA?.connections).not.toContain(nodeB.nodeId);
    expect(updatedNodeA?.connections).toEqual([]);
    expect(updatedNodeC?.connections).toEqual([]);

    await storageService.deleteJobAsync(job.jobId);
  });

  it("should clear entrypointNodeId when entrypoint node is deleted", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const { job, nodeA } = await createJobWithNodeChain(storageService);

    await storageService.updateJobAsync(job.jobId, { entrypointNodeId: nodeA.nodeId });
    await storageService.deleteNodeAsync(job.jobId, nodeA.nodeId);

    const updatedJob: IJob | null = await storageService.getJobAsync(job.jobId);

    expect(updatedJob?.entrypointNodeId).toBeFalsy();

    await storageService.deleteJobAsync(job.jobId);
  });

  it("should not affect connections to non-deleted nodes", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const { job, nodeA, nodeB, nodeC } = await createJobWithNodeChain(storageService);

    await storageService.updateNodeAsync(job.jobId, nodeA.nodeId, {
      connections: [nodeB.nodeId, nodeC.nodeId],
    });

    await storageService.deleteNodeAsync(job.jobId, nodeC.nodeId);

    const updatedNodeA: INode | null = await storageService.getNodeAsync(job.jobId, nodeA.nodeId);

    expect(updatedNodeA?.connections).toContain(nodeB.nodeId);
    expect(updatedNodeA?.connections).not.toContain(nodeC.nodeId);

    await storageService.deleteJobAsync(job.jobId);
  });
});

//#endregion Tests
