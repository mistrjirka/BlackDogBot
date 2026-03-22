# Graph Integrity Fixes Implementation Plan

**Goal:** Implement graph cleanup on node deletion, block invalid connections to start nodes, increase agent max steps, and add scheduling guidance with full test coverage.

**Architecture:** Localized fixes in storage, tool validation, shared constants, and prompt text. Cleanup logic lives in `JobStorageService.deleteNodeAsync()` with best-effort warnings; tool validation rejects connections into start nodes before cycle/schema checks. Tests follow existing integration/unit patterns with real storage in temp HOME.

**Design:** `thoughts/shared/designs/2026-02-22-graph-integrity-fixes-design.md`

---

## Dependency Graph

```
Batch 1 (parallel): 1.1, 1.2, 1.3, 1.4 [foundation - no deps]
Batch 2 (parallel): 2.1, 2.2, 2.3, 2.4 [core + tests - depends on batch 1]
```

---

## Batch 1: Foundation (parallel - 4 implementers)

All tasks in this batch have NO dependencies and run simultaneously.

### Task 1.1: JobStorageService cleanup on node deletion
**File:** `src/services/job-storage.service.ts`
**Test:** `tests/integration/remove-node-cleanup.test.ts`
**Depends:** none

```typescript
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-remove-node-cleanup-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
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
```

```typescript
  public async deleteNodeAsync(jobId: string, nodeId: string): Promise<void> {
    const nodeFilePath: string = getNodeFilePath(jobId, nodeId);
    await fs.rm(nodeFilePath, { force: true });

    const testFilePath: string = getNodeTestFilePath(jobId, nodeId);
    const testExists: boolean = await this._fileExistsAsync(testFilePath);

    if (testExists) {
      await fs.rm(testFilePath, { force: true });
    }

    this._logger.info("Node deleted", { jobId, nodeId });

    try {
      const remainingNodes: INode[] = await this.listNodesAsync(jobId);

      for (const node of remainingNodes) {
        if (node.connections.includes(nodeId)) {
          const updatedConnections: string[] = node.connections.filter(
            (connectionId: string): boolean => connectionId !== nodeId,
          );

          await this.updateNodeAsync(jobId, node.nodeId, {
            connections: updatedConnections,
          });
        }
      }

      const job: IJob | null = await this.getJobAsync(jobId);

      if (job && job.entrypointNodeId === nodeId) {
        await this.updateJobAsync(jobId, { entrypointNodeId: undefined });
      }
    } catch (error: unknown) {
      this._logger.warn("Node deletion cleanup failed", {
        jobId,
        nodeId,
        error: (error as Error).message,
      });
    }

    this.events.emit("graph_changed", { jobId });
  }
```

**Verify:** `pnpm vitest run tests/integration/remove-node-cleanup.test.ts --reporter=verbose`
**Commit:** `fix(storage): clean graph on node deletion`

### Task 1.2: Block connections to start nodes
**File:** `src/tools/connect-nodes.tool.ts`
**Test:** `tests/integration/connect-nodes-validation.test.ts`
**Depends:** none

```typescript
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-connect-validation-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
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
      });

      expect(result.success).toBe(false);
      expect(result.schemaCompatible).toBe(false);
      expect(result.message).toContain("Schema incompatibility");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });

    it("should return success: true when connecting nodes with compatible schemas", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeC } = await createTestJobWithNodes(storageService);

      // Execute with compatible nodes - nodeA outputs to nodeC (flexible schema)
      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeC.nodeId,
      });

      expect(result.success).toBe(true);
      expect(result.schemaCompatible).toBe(true);
      expect(result.message).toContain("connected successfully");

      // Verify connection was actually made
      const updatedNodeA = await storageService.getNodeAsync(job.jobId, nodeA.nodeId);
      expect(updatedNodeA?.connections).toContain(nodeC.nodeId);

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });

  describe("cycle detection blocking", () => {
    it("should return success: false when connection would create a cycle", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB, nodeC } = await createTestJobWithNodes(storageService);

      // Create chain: A -> B -> C (using compatible connections)
      await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeC.nodeId,
      });

      await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeB.nodeId,
        toNodeId: nodeC.nodeId,
      });

      // Try to create cycle: C -> A (should be blocked)
      // Note: This would only work if schemas were compatible, but we test cycle detection
      // First connect A -> C, then try C -> A
      // Actually, let's create a proper chain with compatible nodes

      // Cleanup and create a proper test
      await storageService.deleteJobAsync(job.jobId);

      // Create new job with compatible nodes for cycle test
      const job2: IJob = await storageService.createJobAsync(
        "Cycle Test Job",
        "Testing cycle detection",
      );

      // Create three nodes with flexible schemas
      const node1: INode = await storageService.addNodeAsync(
        job2.jobId,
        "start",
        "Node 1",
        "First node",
        {},
        {},
        { scheduledTaskId: null },
      );

      const node2: INode = await storageService.addNodeAsync(
        job2.jobId,
        "start",
        "Node 2",
        "Second node",
        {},
        {},
        { scheduledTaskId: null },
      );

      const node3: INode = await storageService.addNodeAsync(
        job2.jobId,
        "start",
        "Node 3",
        "Third node",
        {},
        {},
        { scheduledTaskId: null },
      );

      // Create chain: 1 -> 2 -> 3
      await execConnectNodesTool({
        jobId: job2.jobId,
        fromNodeId: node1.nodeId,
        toNodeId: node2.nodeId,
      });

      await execConnectNodesTool({
        jobId: job2.jobId,
        fromNodeId: node2.nodeId,
        toNodeId: node3.nodeId,
      });

      // Try to create cycle: 3 -> 1 (should be blocked)
      const result = await execConnectNodesTool({
        jobId: job2.jobId,
        fromNodeId: node3.nodeId,
        toNodeId: node1.nodeId,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("cycle");

      // Cleanup
      await storageService.deleteJobAsync(job2.jobId);
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
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");

      // Cleanup
      await storageService.deleteJobAsync(job.jobId);
    });
  });

  describe("start node validation", () => {
    it("should reject connection to a start node", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB } = await createTestJobWithNodes(storageService);

      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("start node");

      await storageService.deleteJobAsync(job.jobId);
    });
  });
});

//#endregion Tests
```

```typescript
      if (toNode.type === "start") {
        return {
          success: false,
          schemaCompatible: false,
          message:
            "Cannot connect to a start node — start nodes are entry points and receive no input from other nodes.",
        };
      }

      // Cycle detection
      const allNodes: INode[] = await storageService.listNodesAsync(jobId);
```

**Verify:** `pnpm vitest run tests/integration/connect-nodes-validation.test.ts --reporter=verbose`
**Commit:** `fix(tools): block connections into start nodes`

### Task 1.3: Increase DEFAULT_AGENT_MAX_STEPS
**File:** `src/shared/constants.ts`
**Test:** `tests/unit/constants.test.ts`
**Depends:** none

```typescript
import { describe, it, expect } from "vitest";

import { DEFAULT_AGENT_MAX_STEPS } from "../../src/shared/constants.js";

describe("constants", () => {
  it("DEFAULT_AGENT_MAX_STEPS should be at least 150", () => {
    expect(DEFAULT_AGENT_MAX_STEPS).toBeGreaterThanOrEqual(150);
  });
});
```

```typescript
export const DEFAULT_AGENT_MAX_STEPS: number = 150;
```

**Verify:** `pnpm vitest run tests/unit/constants.test.ts --reporter=verbose`
**Commit:** `chore(constants): raise default agent max steps`

### Task 1.4: Add multi-schedule guidance to job creation guide
**File:** `src/defaults/prompts/job-creation-guide.md`
**Test:** none
**Depends:** none

```markdown
**Important**: Each job supports exactly ONE schedule. If the user needs different schedules (e.g., every 30 minutes AND every 12 hours), create SEPARATE jobs — one for each schedule.
```

```markdown
**Note:** `set_job_schedule` is preferred over `add_cron` for job scheduling
because it links the schedule to the job's start node, making it easy to
update or remove later. Use `add_cron` only for general-purpose scheduled
tasks that are not tied to a specific job.

**Important**: Each job supports exactly ONE schedule. If the user needs different schedules (e.g., every 30 minutes AND every 12 hours), create SEPARATE jobs — one for each schedule.
</job_scheduling>
```

**Verify:** none
**Commit:** `docs(prompts): add single-schedule guidance`

---

## Batch 2: Core Modules + Test Integration (parallel - 4 implementers)

All tasks in this batch depend on Batch 1 completing.

### Task 2.1: Validate deleteNodeAsync cleanup interactions
**File:** `tests/integration/remove-node-cleanup.test.ts`
**Test:** `tests/integration/remove-node-cleanup.test.ts`
**Depends:** 1.1

```typescript
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-remove-node-cleanup-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
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
```

**Verify:** `pnpm vitest run tests/integration/remove-node-cleanup.test.ts --reporter=verbose`
**Commit:** `test(integration): cover node deletion cleanup`

### Task 2.2: Validate start-node rejection in connect_nodes
**File:** `tests/integration/connect-nodes-validation.test.ts`
**Test:** `tests/integration/connect-nodes-validation.test.ts`
**Depends:** 1.2

```typescript
  describe("start node validation", () => {
    it("should reject connection to a start node", async () => {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const { job, nodeA, nodeB } = await createTestJobWithNodes(storageService);

      const result = await execConnectNodesTool({
        jobId: job.jobId,
        fromNodeId: nodeA.nodeId,
        toNodeId: nodeB.nodeId,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("start node");

      await storageService.deleteJobAsync(job.jobId);
    });
  });
```

**Verify:** `pnpm vitest run tests/integration/connect-nodes-validation.test.ts --reporter=verbose`
**Commit:** `test(integration): assert start node connection rejection`

### Task 2.3: Validate DEFAULT_AGENT_MAX_STEPS update
**File:** `tests/unit/constants.test.ts`
**Test:** `tests/unit/constants.test.ts`
**Depends:** 1.3

```typescript
import { describe, it, expect } from "vitest";

import { DEFAULT_AGENT_MAX_STEPS } from "../../src/shared/constants.js";

describe("constants", () => {
  it("DEFAULT_AGENT_MAX_STEPS should be at least 150", () => {
    expect(DEFAULT_AGENT_MAX_STEPS).toBeGreaterThanOrEqual(150);
  });
});
```

**Verify:** `pnpm vitest run tests/unit/constants.test.ts --reporter=verbose`
**Commit:** `test(unit): guard default max steps`

### Task 2.4: Validate multi-schedule guidance text
**File:** `src/defaults/prompts/job-creation-guide.md`
**Test:** none
**Depends:** 1.4

```markdown
**Important**: Each job supports exactly ONE schedule. If the user needs different schedules (e.g., every 30 minutes AND every 12 hours), create SEPARATE jobs — one for each schedule.
```

**Verify:** none
**Commit:** `docs(prompts): ensure single schedule guidance`

---

## Overall Verification

1. `pnpm tsc --noEmit`
2. `pnpm vitest run tests/integration/remove-node-cleanup.test.ts --reporter=verbose`
3. `pnpm vitest run tests/integration/connect-nodes-validation.test.ts --reporter=verbose`
4. `pnpm vitest run tests/unit/constants.test.ts --reporter=verbose`
5. `pnpm vitest run --reporter=verbose`
