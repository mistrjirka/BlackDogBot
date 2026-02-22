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

async function createTestJobWithNodes(
  storageService: JobStorageService,
): Promise<{ job: IJob; nodeA: INode; nodeB: INode; nodeC: INode }> {
  const job: IJob = await storageService.createJobAsync(
    "Test Disconnect Job",
    "A job for testing disconnect_nodes tool",
  );

  const nodeA: INode = await storageService.addNodeAsync(
    job.jobId,
    "manual",
    "Node A",
    "First node",
    {},
    {},
    {},
  );

  const nodeB: INode = await storageService.addNodeAsync(
    job.jobId,
    "manual",
    "Node B",
    "Second node",
    {},
    {},
    {},
  );

  const nodeC: INode = await storageService.addNodeAsync(
    job.jobId,
    "manual",
    "Node C",
    "Third node",
    {},
    {},
    {},
  );

  return { job, nodeA, nodeB, nodeC };
}

//#endregion Helpers

//#region Tests

describe("disconnect_nodes tool", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-disconnect-"));
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

  describe("successful disconnect", () => {
    it("should successfully remove a connection between two nodes", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB } = await createTestJobWithNodes(storageService);

      // Connect A -> B
      await storageService.updateNodeAsync(job.jobId, nodeA.nodeId, {
        connections: [nodeB.nodeId],
      });

      // Verify connection exists
      const nodeBeforeDisconnect: INode | null = await storageService.getNodeAsync(job.jobId, nodeA.nodeId);
      expect(nodeBeforeDisconnect?.connections).toContain(nodeB.nodeId);

      // Import tool dynamically to get fresh instance with our JobStorageService
      const { disconnectNodesTool } = await import("../../src/tools/disconnect-nodes.tool.js");

      // Disconnect A -> B
      const result = await disconnectNodesTool.execute({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("removed successfully");

      // Verify connection is removed
      const nodeAfterDisconnect: INode | null = await storageService.getNodeAsync(job.jobId, nodeA.nodeId);
      expect(nodeAfterDisconnect?.connections).not.toContain(nodeB.nodeId);
      expect(nodeAfterDisconnect?.connections).toHaveLength(0);

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });

  describe("error handling", () => {
    it("should return error if source node doesn't exist", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeB } = await createTestJobWithNodes(storageService);

      const { disconnectNodesTool } = await import("../../src/tools/disconnect-nodes.tool.js");

      const result = await disconnectNodesTool.execute({
        jobId: job.jobId,
        fromNodeId: "non-existent-node-id",
        toNodeId: nodeB.nodeId,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("Source node");
      expect(result.message).toContain("not found");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });

    it("should return error if target node doesn't exist", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA } = await createTestJobWithNodes(storageService);

      const { disconnectNodesTool } = await import("../../src/tools/disconnect-nodes.tool.js");

      const result = await disconnectNodesTool.execute({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: "non-existent-node-id",
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("Target node");
      expect(result.message).toContain("not found");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });

    it("should return error if no connection exists between the nodes", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB } = await createTestJobWithNodes(storageService);

      // Don't connect them - they have no connection

      const { disconnectNodesTool } = await import("../../src/tools/disconnect-nodes.tool.js");

      const result = await disconnectNodesTool.execute({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("No connection exists");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });

  describe("storage updates", () => {
    it("should update storage correctly after disconnect", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB, nodeC } = await createTestJobWithNodes(storageService);

      // Connect A -> B and B -> C
      await storageService.updateNodeAsync(job.jobId, nodeA.nodeId, {
        connections: [nodeB.nodeId],
      });
      await storageService.updateNodeAsync(job.jobId, nodeB.nodeId, {
        connections: [nodeC.nodeId],
      });

      const { disconnectNodesTool } = await import("../../src/tools/disconnect-nodes.tool.js");

      // Disconnect A -> B
      const result = await disconnectNodesTool.execute({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
      });

      expect(result.success).toBe(true);

      // Verify A has no connections
      const nodeAAfter: INode | null = await storageService.getNodeAsync(job.jobId, nodeA.nodeId);
      expect(nodeAAfter?.connections).toHaveLength(0);

      // Verify B still has connection to C (unchanged)
      const nodeBAfter: INode | null = await storageService.getNodeAsync(job.jobId, nodeB.nodeId);
      expect(nodeBAfter?.connections).toContain(nodeC.nodeId);
      expect(nodeBAfter?.connections).toHaveLength(1);

      // Verify C has no connections (unchanged)
      const nodeCAfter: INode | null = await storageService.getNodeAsync(job.jobId, nodeC.nodeId);
      expect(nodeCAfter?.connections).toHaveLength(0);

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });
});

//#endregion Tests
