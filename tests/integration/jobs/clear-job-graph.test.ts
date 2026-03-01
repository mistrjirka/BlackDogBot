import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import type { IJob, INode } from "../../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

async function execClearJobGraphTool(
  jobId: string,
): Promise<{ success: boolean; message: string; clearedNodesCount: number; graphAscii: string }> {
  const { clearJobGraphTool } = await import("../../src/tools/clear-job-graph.tool.js");
  const execute = clearJobGraphTool.execute;

  if (!execute) {
    throw new Error("clear_job_graph tool execute function is not available.");
  }

  const result = await execute(
    { jobId },
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );

  if (isAsyncIterable<{ success: boolean; message: string; clearedNodesCount: number; graphAscii: string }>(result)) {
    let lastChunk: { success: boolean; message: string; clearedNodesCount: number; graphAscii: string } | null = null;
    for await (const chunk of result) {
      lastChunk = chunk;
    }

    if (!lastChunk) {
      throw new Error("clear_job_graph tool returned no result.");
    }

    return lastChunk;
  }

  return result as { success: boolean; message: string; clearedNodesCount: number; graphAscii: string };
}

async function createTestJobWithNodes(
  storageService: JobStorageService,
  nodeCount: number,
): Promise<{ job: IJob; nodes: INode[] }> {
  const job: IJob = await storageService.createJobAsync(
    "Test Clear Job",
    "A job for testing clear_job_graph tool",
  );

  const nodes: INode[] = [];

  for (let i: number = 0; i < nodeCount; i += 1) {
    const node: INode = await storageService.addNodeAsync(
      job.jobId,
      "start",
      `Node ${i + 1}`,
      `Test node ${i + 1}`,
      {},
      {},
      {},
    );
    nodes.push(node);
  }

  return { job, nodes };
}

//#endregion Helpers

//#region Tests

describe("clear_job_graph tool", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-clear-"));
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

  it("clears a job that has nodes and returns ascii graph", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const { job, nodes } = await createTestJobWithNodes(storageService, 3);

    await storageService.updateNodeAsync(job.jobId, nodes[0].nodeId, {
      connections: [nodes[1].nodeId],
    });
    await storageService.updateNodeAsync(job.jobId, nodes[1].nodeId, {
      connections: [nodes[2].nodeId],
    });
    await storageService.updateJobAsync(job.jobId, { entrypointNodeId: nodes[0].nodeId });

    const result = await execClearJobGraphTool(job.jobId);

    expect(result.success).toBe(true);
    const graphAscii: string = result.graphAscii ?? "";
    expect(graphAscii).toContain("(no nodes)");

    const nodesAfter: INode[] = await storageService.listNodesAsync(job.jobId);
    expect(nodesAfter).toHaveLength(0);

    await storageService.deleteJobAsync(job.jobId);
  });

  it("returns the clearedNodesCount for the job", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const { job, nodes } = await createTestJobWithNodes(storageService, 2);

    const result = await execClearJobGraphTool(job.jobId);

    expect(result.success).toBe(true);
    expect(result.clearedNodesCount).toBe(nodes.length);

    const nodesAfter: INode[] = await storageService.listNodesAsync(job.jobId);
    expect(nodesAfter).toHaveLength(0);

    await storageService.deleteJobAsync(job.jobId);
  });
});

//#endregion Tests
