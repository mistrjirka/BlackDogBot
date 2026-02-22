import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

import { IJob, INode, INodeTestCase, JobStatus, NodeConfig, NodeType } from "../shared/types/index.js";
import { generateId } from "../utils/id.js";
import { LoggerService } from "./logger.service.js";
import {
  getJobsDir,
  getJobDir,
  getJobNodesDir,
  getJobTestsDir,
  getNodeFilePath,
  getNodeTestFilePath,
  ensureDirectoryExistsAsync,
} from "../utils/paths.js";

export class JobStorageService {
  //#region Data members

  public readonly events = new EventEmitter();
  private static _instance: JobStorageService | null;
  private _logger: LoggerService;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): JobStorageService {
    if (!JobStorageService._instance) {
      JobStorageService._instance = new JobStorageService();
    }

    return JobStorageService._instance;
  }

  public async createJobAsync(name: string, description: string): Promise<IJob> {
    const jobId: string = generateId();
    const now: string = new Date().toISOString();

    const job: IJob = {
      jobId,
      name,
      description,
      status: "creating",
      entrypointNodeId: null,
      createdAt: now,
      updatedAt: now,
    };

    await ensureDirectoryExistsAsync(getJobDir(jobId));
    await ensureDirectoryExistsAsync(getJobNodesDir(jobId));
    await ensureDirectoryExistsAsync(getJobTestsDir(jobId));

    const jobFilePath: string = `${getJobDir(jobId)}/job.json`;
    await this._writeJsonAsync(jobFilePath, job);

    this._logger.info("Job created", { jobId, name });
    this.events.emit("graph_changed", { jobId });

    return job;
  }

  public async getJobAsync(jobId: string): Promise<IJob | null> {
    const jobFilePath: string = `${getJobDir(jobId)}/job.json`;
    const exists: boolean = await this._fileExistsAsync(jobFilePath);

    if (!exists) {
      return null;
    }

    return this._readJsonAsync<IJob>(jobFilePath);
  }

  public async listJobsAsync(statusFilter?: JobStatus): Promise<IJob[]> {
    const jobsDir: string = getJobsDir();
    const exists: boolean = await this._fileExistsAsync(jobsDir);

    if (!exists) {
      return [];
    }

    const entries: string[] = await fs.readdir(jobsDir);
    const jobs: IJob[] = [];

    for (const entry of entries) {
      const jobFilePath: string = `${getJobDir(entry)}/job.json`;
      const fileExists: boolean = await this._fileExistsAsync(jobFilePath);

      if (!fileExists) {
        continue;
      }

      const job: IJob = await this._readJsonAsync<IJob>(jobFilePath);

      if (statusFilter && job.status !== statusFilter) {
        continue;
      }

      jobs.push(job);
    }

    return jobs;
  }

  public async updateJobAsync(
    jobId: string,
    updates: Partial<Pick<IJob, "name" | "description" | "status" | "entrypointNodeId">>,
  ): Promise<IJob> {
    const existingJob: IJob | null = await this.getJobAsync(jobId);

    if (!existingJob) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const updatedJob: IJob = {
      ...existingJob,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    const jobFilePath: string = `${getJobDir(jobId)}/job.json`;
    await this._writeJsonAsync(jobFilePath, updatedJob);

    this._logger.info("Job updated", { jobId });
    this.events.emit("graph_changed", { jobId });

    return updatedJob;
  }

  public async deleteJobAsync(jobId: string): Promise<void> {
    const dir: string = getJobDir(jobId);
    await fs.rm(dir, { recursive: true, force: true });

    this._logger.info("Job deleted", { jobId });
    this.events.emit("graph_changed", { jobId });
  }

  public async deleteAllJobsAsync(): Promise<void> {
    const jobsDir: string = getJobsDir();
    await fs.rm(jobsDir, { recursive: true, force: true });
    await ensureDirectoryExistsAsync(jobsDir);

    this._logger.info("All jobs deleted");
  }

  /**
   * Clean up orphaned jobs that are stuck in "creating" status.
   * This can happen if the job creation process was interrupted.
   * Should be called on startup.
   */
  public async cleanupOrphanedCreatingJobsAsync(): Promise<number> {
    const creatingJobs: IJob[] = await this.listJobsAsync("creating");

    if (creatingJobs.length === 0) {
      return 0;
    }

    this._logger.warn("Found orphaned jobs in 'creating' status, cleaning up", {
      count: creatingJobs.length,
      jobIds: creatingJobs.map((j) => j.jobId),
    });

    for (const job of creatingJobs) {
      await this.deleteJobAsync(job.jobId);
    }

    return creatingJobs.length;
  }

  public async addNodeAsync(
    jobId: string,
    type: NodeType,
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    outputSchema: Record<string, unknown>,
    config: NodeConfig,
  ): Promise<INode> {
    const nodeId: string = generateId();
    const now: string = new Date().toISOString();

    const node: INode = {
      nodeId,
      jobId,
      type,
      name,
      description,
      inputSchema,
      outputSchema,
      connections: [],
      config,
      createdAt: now,
      updatedAt: now,
    };

    await ensureDirectoryExistsAsync(getJobNodesDir(jobId));

    const nodeFilePath: string = getNodeFilePath(jobId, nodeId);
    await this._writeJsonAsync(nodeFilePath, node);

    this._logger.info("Node added", { jobId, nodeId, type });
    this.events.emit("graph_changed", { jobId });

    return node;
  }

  public async getNodeAsync(jobId: string, nodeId: string): Promise<INode | null> {
    const nodeFilePath: string = getNodeFilePath(jobId, nodeId);
    const exists: boolean = await this._fileExistsAsync(nodeFilePath);

    if (!exists) {
      return null;
    }

    return this._readJsonAsync<INode>(nodeFilePath);
  }

  public async listNodesAsync(jobId: string): Promise<INode[]> {
    const nodesDir: string = getJobNodesDir(jobId);
    const exists: boolean = await this._fileExistsAsync(nodesDir);

    if (!exists) {
      return [];
    }

    const entries: string[] = await fs.readdir(nodesDir);
    const nodes: INode[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      const filePath: string = `${nodesDir}/${entry}`;
      const node: INode = await this._readJsonAsync<INode>(filePath);
      nodes.push(node);
    }

    return nodes;
  }

  public async updateNodeAsync(
    jobId: string,
    nodeId: string,
    updates: Partial<Pick<INode, "name" | "description" | "inputSchema" | "outputSchema" | "config" | "connections">>,
  ): Promise<INode> {
    const existingNode: INode | null = await this.getNodeAsync(jobId, nodeId);

    if (!existingNode) {
      throw new Error(`Node not found: ${nodeId} in job ${jobId}`);
    }

    const updatedNode: INode = {
      ...existingNode,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    const nodeFilePath: string = getNodeFilePath(jobId, nodeId);
    await this._writeJsonAsync(nodeFilePath, updatedNode);

    this._logger.info("Node updated", { jobId, nodeId });

    return updatedNode;
  }

  public async deleteNodeAsync(jobId: string, nodeId: string): Promise<void> {
    const nodeFilePath: string = getNodeFilePath(jobId, nodeId);
    await fs.rm(nodeFilePath, { force: true });

    const testFilePath: string = getNodeTestFilePath(jobId, nodeId);
    const testExists: boolean = await this._fileExistsAsync(testFilePath);

    if (testExists) {
      await fs.rm(testFilePath, { force: true });
    }

    this._logger.info("Node deleted", { jobId, nodeId });
    this.events.emit("graph_changed", { jobId });
  }

  public async addTestCaseAsync(
    jobId: string,
    nodeId: string,
    name: string,
    inputData: Record<string, unknown>,
  ): Promise<INodeTestCase> {
    const node: INode | null = await this.getNodeAsync(jobId, nodeId);

    if (node && node.type === "start") {
      throw new Error("Test cases cannot be created for start nodes — they are passthroughs with no logic to test.");
    }

    const testId: string = generateId();
    const now: string = new Date().toISOString();

    const testCase: INodeTestCase = {
      testId,
      nodeId,
      jobId,
      name,
      inputData,
      expectedOutputSchema: null,
      createdAt: now,
    };

    const testFilePath: string = getNodeTestFilePath(jobId, nodeId);
    const existingTests: INodeTestCase[] = await this.getTestCasesAsync(jobId, nodeId);

    const existingIndex = existingTests.findIndex((t) => t.name === name);
    if (existingIndex !== -1) {
      testCase.testId = existingTests[existingIndex].testId;
      testCase.createdAt = existingTests[existingIndex].createdAt;
      existingTests[existingIndex] = testCase;
    } else {
      existingTests.push(testCase);
    }

    await ensureDirectoryExistsAsync(getJobTestsDir(jobId));
    await this._writeJsonAsync(testFilePath, existingTests);

    this._logger.info("Test case added", { jobId, nodeId, testId });

    return testCase;
  }

  public async getTestCasesAsync(jobId: string, nodeId: string): Promise<INodeTestCase[]> {
    const testFilePath: string = getNodeTestFilePath(jobId, nodeId);
    const exists: boolean = await this._fileExistsAsync(testFilePath);

    if (!exists) {
      return [];
    }

    return this._readJsonAsync<INodeTestCase[]>(testFilePath);
  }

  //#endregion Public methods

  //#region Private methods

  private async _fileExistsAsync(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async _readJsonAsync<T>(filePath: string): Promise<T> {
    const content: string = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  }

  private async _writeJsonAsync(filePath: string, data: unknown): Promise<void> {
    const content: string = JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, content, "utf-8");
  }

  //#endregion Private methods
}
