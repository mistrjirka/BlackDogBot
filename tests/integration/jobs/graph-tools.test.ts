import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { createEditNodeTool } from "../../../src/tools/edit-node.tool.js";
import { setEntrypointTool } from "../../../src/tools/set-entrypoint.tool.js";
import { connectNodesTool } from "../../../src/tools/connect-nodes.tool.js";
import { JobActivityTracker } from "../../../src/utils/job-activity-tracker.js";
import { createNodeAsync, ICreateNodeResult } from "../../../src/utils/node-creation-helper.js";
import type { IJob, INode } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;


async function initServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("error", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".betterclaw");
  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, path.join(tempConfigDir, "config.yaml"));
  await configService.initializeAsync(path.join(tempConfigDir, "config.yaml"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execTool<T>(toolObj: any, args: unknown): Promise<T> {
  if (!toolObj.execute) {
    throw new Error("Tool has no execute function");
  }

  return await toolObj.execute(
    args,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  ) as T;
}


//#region Tests

describe("graph tools", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-graph-tools-"));
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

  //#region edit_node

  describe("edit_node", () => {
    it("should update node name and description", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Edit Test Job", "desc");
      const node: INode = await storage.addNodeAsync(
        job.jobId, "start", "Original Name", "Original Description",
        {}, {}, {},
      );

      const editTool = createEditNodeTool(new JobActivityTracker());

      const result = await execTool<{ success: boolean; message: string }>(editTool, {
        jobId: job.jobId,
        nodeId: node.nodeId,
        name: "Updated Name",
        description: "Updated Description",
      });

      expect(result.success).toBe(true);

      const updated: INode | null = await storage.getNodeAsync(job.jobId, node.nodeId);
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.description).toBe("Updated Description");
    });

    it("should update node input and output schemas", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Schema Edit Job", "desc");
      const node: INode = await storage.addNodeAsync(
        job.jobId, "python_code", "Code Node", "desc",
        {}, {}, { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
      );

      const editTool = createEditNodeTool(new JobActivityTracker());

      const newInputSchema = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };

      const result = await execTool<{ success: boolean; message: string }>(editTool, {
        jobId: job.jobId,
        nodeId: node.nodeId,
        inputSchema: newInputSchema,
      });

      expect(result.success).toBe(true);

      const updated: INode | null = await storage.getNodeAsync(job.jobId, node.nodeId);
      expect(updated?.inputSchema).toEqual(newInputSchema);
    });

    it("should update node config", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Config Edit Job", "desc");
      const node: INode = await storage.addNodeAsync(
        job.jobId, "python_code", "Code Node", "desc",
        {}, {}, { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
      );

      const editTool = createEditNodeTool(new JobActivityTracker());

      const result = await execTool<{ success: boolean; message: string }>(editTool, {
        jobId: job.jobId,
        nodeId: node.nodeId,
        config: { code: "print('{\"result\": 42}')", pythonPath: "python3", timeout: 10000 },
      });

      expect(result.success).toBe(true);

      const updated: INode | null = await storage.getNodeAsync(job.jobId, node.nodeId);
      expect((updated?.config as Record<string, unknown>).timeout).toBe(10000);
    });

    it("should convert outputSchema blueprint to JSON Schema", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Blueprint Edit Job", "desc");
      const node: INode = await storage.addNodeAsync(
        job.jobId, "agent", "Agent Node", "desc",
        {}, {}, { systemPrompt: "test", selectedTools: ["think"], maxSteps: 5 },
      );

      const editTool = createEditNodeTool(new JobActivityTracker());

      const result = await execTool<{ success: boolean; message: string }>(editTool, {
        jobId: job.jobId,
        nodeId: node.nodeId,
        outputSchema: {
          type: "object",
          fields: [
            { name: "answer", type: "string" },
            { name: "score", type: "number" },
          ],
        },
      });

      expect(result.success).toBe(true);

      const updated: INode | null = await storage.getNodeAsync(job.jobId, node.nodeId);
      const schema = updated?.outputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect((schema.properties as Record<string, unknown>)).toHaveProperty("answer");
      expect((schema.properties as Record<string, unknown>)).toHaveProperty("score");
    });

    it("should fail for non-existent node", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Missing Node Job", "desc");

      const editTool = createEditNodeTool(new JobActivityTracker());

      const result = await execTool<{ success: boolean; message: string }>(editTool, {
        jobId: job.jobId,
        nodeId: "non-existent-node",
        name: "New Name",
      });

      expect(result.success).toBe(false);
    });
  });

  //#endregion edit_node

  //#region set_entrypoint

  describe("set_entrypoint", () => {
    it("should set entrypoint to an existing node", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Entrypoint Job", "desc");
      const node: INode = await storage.addNodeAsync(
        job.jobId, "start", "Start Node", "desc", {}, {}, {},
      );

      const result = await execTool<{ success: boolean; message: string }>(setEntrypointTool, {
        jobId: job.jobId,
        nodeId: node.nodeId,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain(node.nodeId);

      const updatedJob: IJob | null = await storage.getJobAsync(job.jobId);
      expect(updatedJob?.entrypointNodeId).toBe(node.nodeId);
    });

    it("should allow changing entrypoint to a different node", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Change Entrypoint Job", "desc");
      const nodeA: INode = await storage.addNodeAsync(
        job.jobId, "start", "Node A", "first", {}, {}, {},
      );
      const nodeB: INode = await storage.addNodeAsync(
        job.jobId, "start", "Node B", "second", {}, {}, {},
      );

      await storage.updateJobAsync(job.jobId, { entrypointNodeId: nodeA.nodeId });

      const result = await execTool<{ success: boolean; message: string }>(setEntrypointTool, {
        jobId: job.jobId,
        nodeId: nodeB.nodeId,
      });

      expect(result.success).toBe(true);

      const updatedJob: IJob | null = await storage.getJobAsync(job.jobId);
      expect(updatedJob?.entrypointNodeId).toBe(nodeB.nodeId);
    });

    it("should fail for non-existent node", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Bad Entrypoint Job", "desc");

      const result = await execTool<{ success: boolean; message: string }>(setEntrypointTool, {
        jobId: job.jobId,
        nodeId: "does-not-exist",
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });
  });

  //#endregion set_entrypoint

  //#region connect_nodes schema checks

  describe("connect_nodes", () => {
    it("should block connection when required input fields are missing from output", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Schema Block Job", "desc");

      const nodeA: INode = await storage.addNodeAsync(
        job.jobId, "start", "Source", "outputs only foo",
        {},
        { type: "object", properties: { foo: { type: "string" } } },
        {},
      );

      const nodeB: INode = await storage.addNodeAsync(
        job.jobId, "python_code", "Sink", "requires bar",
        { type: "object", properties: { bar: { type: "number" } }, required: ["bar"] },
        {},
        { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
      );

      await storage.updateJobAsync(job.jobId, { entrypointNodeId: nodeA.nodeId });

      const result = await execTool<{ success: boolean; message: string; schemaCompatible: boolean }>(
        connectNodesTool,
        { jobId: job.jobId, fromNodeId: nodeA.nodeId, toNodeId: nodeB.nodeId },
      );

      expect(result.success).toBe(false);
      expect(result.schemaCompatible).toBe(false);
      expect(result.message).toContain("bar");
    });

    it("should allow connection when schemas are compatible", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Schema OK Job", "desc");

      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };

      const nodeA: INode = await storage.addNodeAsync(
        job.jobId, "start", "Source", "outputs value", {}, schema, {},
      );
      const nodeB: INode = await storage.addNodeAsync(
        job.jobId, "python_code", "Sink", "requires value", schema, schema,
        { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
      );

      await storage.updateJobAsync(job.jobId, { entrypointNodeId: nodeA.nodeId });

      const result = await execTool<{ success: boolean; message: string; schemaCompatible: boolean }>(
        connectNodesTool,
        { jobId: job.jobId, fromNodeId: nodeA.nodeId, toNodeId: nodeB.nodeId },
      );

      expect(result.success).toBe(true);
      expect(result.schemaCompatible).toBe(true);
    });

    it("should block connection to start node", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Start Block Job", "desc");

      const nodeA: INode = await storage.addNodeAsync(
        job.jobId, "python_code", "Code", "desc", {}, {}, { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
      );
      const nodeB: INode = await storage.addNodeAsync(
        job.jobId, "start", "Start", "desc", {}, {}, {},
      );

      const result = await execTool<{ success: boolean; message: string }>(
        connectNodesTool,
        { jobId: job.jobId, fromNodeId: nodeA.nodeId, toNodeId: nodeB.nodeId },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("start node");
    });

    it("should detect cycles", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const job: IJob = await storage.createJobAsync("Cycle Job", "desc");

      const nodeA: INode = await storage.addNodeAsync(
        job.jobId, "python_code", "A", "desc", {}, {},
        { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
      );
      const nodeB: INode = await storage.addNodeAsync(
        job.jobId, "python_code", "B", "desc", {}, {},
        { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
      );

      await storage.updateNodeAsync(job.jobId, nodeA.nodeId, { connections: [nodeB.nodeId] });
      await storage.updateJobAsync(job.jobId, { entrypointNodeId: nodeA.nodeId });

      // Try to connect B -> A (would create cycle)
      const result = await execTool<{ success: boolean; message: string }>(
        connectNodesTool,
        { jobId: job.jobId, fromNodeId: nodeB.nodeId, toNodeId: nodeA.nodeId },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("cycle");
    });
  });

  //#endregion connect_nodes schema checks

  //#region parentNodeId auto-connect schema check

  describe("createNodeAsync schema check on auto-connect", () => {
    it("should skip auto-connection when parent output is incompatible with child input", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const tracker: JobActivityTracker = new JobActivityTracker();
      const job: IJob = await storage.createJobAsync("Incompat Auto Job", "desc");

      const parentNode: INode = await storage.addNodeAsync(
        job.jobId, "start", "Parent", "outputs foo only",
        {},
        { type: "object", properties: { foo: { type: "string" } } },
        {},
      );

      // Create child that requires 'bar' — parent doesn't produce 'bar'
      const result: ICreateNodeResult = await createNodeAsync(
        job.jobId,
        "python_code",
        "Child",
        "requires bar",
        { type: "object", properties: { bar: { type: "number" } }, required: ["bar"] },
        {},
        { code: "print('{}')", pythonPath: "python3", timeout: 5000 },
        parentNode.nodeId,
        tracker,
      );

      // Node created but connection skipped
      expect(result.success).toBe(true);
      expect(result.nodeId).toBeTruthy();
      expect(result.error).toBeDefined();
      expect(result.message).toContain("schema incompatibility");

      // Verify parent has no connections
      const updatedParent: INode | null = await storage.getNodeAsync(job.jobId, parentNode.nodeId);
      expect(updatedParent?.connections).toEqual([]);
    });

    it("should auto-connect when schemas are compatible", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const tracker: JobActivityTracker = new JobActivityTracker();
      const job: IJob = await storage.createJobAsync("Compat Auto Job", "desc");

      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };

      const parentNode: INode = await storage.addNodeAsync(
        job.jobId, "start", "Parent", "outputs value", {}, schema, {},
      );

      const result: ICreateNodeResult = await createNodeAsync(
        job.jobId,
        "start",
        "Child",
        "requires value",
        schema,
        schema,
        {},
        parentNode.nodeId,
        tracker,
      );

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("Connected from parent");

      // Verify parent has connection
      const updatedParent: INode | null = await storage.getNodeAsync(job.jobId, parentNode.nodeId);
      expect(updatedParent?.connections).toContain(result.nodeId);
    });

    it("should auto-connect when child has empty input schema (agent pattern)", async () => {
      const storage: JobStorageService = JobStorageService.getInstance();
      const tracker: JobActivityTracker = new JobActivityTracker();
      const job: IJob = await storage.createJobAsync("Empty Schema Auto Job", "desc");

      const parentNode: INode = await storage.addNodeAsync(
        job.jobId, "start", "Parent", "outputs stuff",
        {},
        { type: "object", properties: { items: { type: "array" } } },
        {},
      );

      // Agent nodes have empty inputSchema — should always connect
      const result: ICreateNodeResult = await createNodeAsync(
        job.jobId,
        "agent",
        "Agent Child",
        "accepts anything",
        {},
        { type: "object", properties: { result: { type: "string" } } },
        { systemPrompt: "test", selectedTools: ["think"], maxSteps: 5 },
        parentNode.nodeId,
        tracker,
      );

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("Connected from parent");
    });
  });

  //#endregion parentNodeId auto-connect schema check
});

//#endregion Tests
