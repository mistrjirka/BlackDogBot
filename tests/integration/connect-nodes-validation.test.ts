import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../src/services/logger.service.js";
import { JobStorageService } from "../../src/services/job-storage.service.js";
import { connectNodesTool } from "../../src/tools/connect-nodes.tool.js";
import type { IJob, INode } from "../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

interface IConnectNodesResult {
  success: boolean;
  message: string;
  schemaCompatible: boolean;
}

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
}

/** Invoke a tool's execute function, bypassing strict input typing for testing. */
async function execConnectNodesTool(args: {
  jobId: string;
  fromNodeId: string;
  toNodeId: string;
  force: boolean;
}): Promise<IConnectNodesResult> {
  if (!connectNodesTool.execute) {
    throw new Error("Tool has no execute function");
  }

  const result = await connectNodesTool.execute(args, {
    toolCallId: "test",
    messages: [],
    abortSignal: new AbortController().signal,
  });

  return result as IConnectNodesResult;
}

async function createTestJobWithNodes(
  storageService: JobStorageService,
): Promise<{ job: IJob; nodeA: INode; nodeB: INode; nodeC: INode }> {
  const job: IJob = await storageService.createJobAsync(
    "Test Connection Validation Job",
    "A job for testing connect_nodes validation",
  );

  // Node A: outputs a string
  const nodeA: INode = await storageService.addNodeAsync(
    job.jobId,
    "start",
    "Node A",
    "Outputs a string value",
    {},
    {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    { scheduledTaskId: null },
  );

  // Node B: expects a number (incompatible with Node A)
  const nodeB: INode = await storageService.addNodeAsync(
    job.jobId,
    "start",
    "Node B",
    "Expects a number value",
    {
      type: "object",
      properties: {
        value: { type: "number" },
      },
      required: ["value"],
    },
    {},
    { scheduledTaskId: null },
  );

  // Node C: compatible with both (no strict schema)
  const nodeC: INode = await storageService.addNodeAsync(
    job.jobId,
    "start",
    "Node C",
    "Flexible input node",
    {},
    {},
    { scheduledTaskId: null },
  );

  return { job, nodeA, nodeB, nodeC };
}

//#endregion Helpers

//#region Tests

describe("connect_nodes tool validation", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-connect-validation-"));
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

  describe("schema incompatibility blocking", () => {
    it("should return success: false when connecting nodes with incompatible schemas", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB } = await createTestJobWithNodes(storageService);

      // Execute the tool - nodeA outputs string, nodeB expects number
      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
        force: false,
      });

      expect(result.success).toBe(false);
      expect(result.schemaCompatible).toBe(false);
      expect(result.message).toContain("Schema incompatibility");
      expect(result.message).toContain("force=true");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });

    it("should return success: true with force=true when schemas are incompatible", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB } = await createTestJobWithNodes(storageService);

      // Execute with force=true - should bypass schema check
      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
        force: true,
      });

      expect(result.success).toBe(true);
      expect(result.schemaCompatible).toBe(false);
      expect(result.message).toContain("forced");

      // Verify connection was actually made
      const updatedNodeA = await storageService.getNodeAsync(job.jobId, nodeA.nodeId);
      expect(updatedNodeA?.connections).toContain(nodeB.nodeId);

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });

  describe("cycle detection blocking", () => {
    it("should return success: false when connection would create a cycle", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB, nodeC } = await createTestJobWithNodes(storageService);

      // Create chain: A -> B -> C
      await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
        force: true,
      });

      await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeB.nodeId,
        toNodeId: nodeC.nodeId,
        force: true,
      });

      // Try to create cycle: C -> A (should be blocked)
      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeC.nodeId,
        toNodeId: nodeA.nodeId,
        force: false,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("cycle");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });

    it("should NOT allow force=true to bypass cycle detection", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB, nodeC } = await createTestJobWithNodes(storageService);

      // Create chain: A -> B -> C
      await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
        force: true,
      });

      await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeB.nodeId,
        toNodeId: nodeC.nodeId,
        force: true,
      });

      // Try to create cycle with force=true (should still be blocked)
      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeC.nodeId,
        toNodeId: nodeA.nodeId,
        force: true,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("cycle");

      // Verify no connection was made
      const nodeCUpdated = await storageService.getNodeAsync(job.jobId, nodeC.nodeId);
      expect(nodeCUpdated?.connections).not.toContain(nodeA.nodeId);

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });

  describe("error handling", () => {
    it("should return success: false when source node does not exist", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeB } = await createTestJobWithNodes(storageService);

      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: "nonexistent-node",
        toNodeId: nodeB.nodeId,
        force: false,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });

    it("should return success: false when target node does not exist", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA } = await createTestJobWithNodes(storageService);

      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: "nonexistent-node",
        force: false,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });
});

//#endregion Tests
