import { exec } from "node:child_process";
import { promisify } from "node:util";

import { IJob, INode, INodeTestCase, INodeTestResult, IPythonCodeConfig, NodeType } from "../shared/types/index.js";
import { DEFAULT_PYTHON_TIMEOUT_MS } from "../shared/constants.js";
import { LoggerService } from "./logger.service.js";
import { JobStorageService } from "./job-storage.service.js";
import { getExecutionOrder } from "../jobs/graph.js";
import { validateDataAgainstSchema } from "../jobs/schema-compat.js";
import { ISchemaCompatResult } from "../jobs/schema-compat.js";

const _execAsync: typeof exec.__promisify__ = promisify(exec);

export class JobExecutorService {
  //#region Data members

  private static _instance: JobExecutorService | null;
  private _logger: LoggerService;
  private _storageService: JobStorageService;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._storageService = JobStorageService.getInstance();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): JobExecutorService {
    if (!JobExecutorService._instance) {
      JobExecutorService._instance = new JobExecutorService();
    }

    return JobExecutorService._instance;
  }

  public async executeJobAsync(
    jobId: string,
    input: Record<string, unknown>,
  ): Promise<{ success: boolean; output: unknown; error: string | null; nodesExecuted: number }> {
    try {
      const job: IJob | null = await this._storageService.getJobAsync(jobId);

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (job.status !== "ready") {
        throw new Error(`Job "${jobId}" is not ready for execution. Current status: ${job.status}`);
      }

      await this._storageService.updateJobAsync(jobId, { status: "running" });

      this._logger.info("Job execution started", { jobId });

      const nodes: INode[] = await this._storageService.listNodesAsync(jobId);
      const executionOrder: string[] = getExecutionOrder(nodes, job.entrypointNodeId!);

      const nodeMap: Map<string, INode> = new Map<string, INode>();

      for (const node of nodes) {
        nodeMap.set(node.nodeId, node);
      }

      const nodeOutputs: Map<string, Record<string, unknown>> = new Map<string, Record<string, unknown>>();

      for (const nodeId of executionOrder) {
        const node: INode | undefined = nodeMap.get(nodeId);

        if (!node) {
          throw new Error(`Node "${nodeId}" not found during execution`);
        }

        let nodeInput: Record<string, unknown>;

        if (nodeId === job.entrypointNodeId) {
          nodeInput = input;
        } else {
          nodeInput = {};

          for (const sourceNode of nodes) {
            if (sourceNode.connections.includes(nodeId)) {
              const sourceOutput: Record<string, unknown> | undefined = nodeOutputs.get(sourceNode.nodeId);

              if (sourceOutput) {
                nodeInput = { ...nodeInput, ...sourceOutput };
              }
            }
          }
        }

        const inputValidation: ISchemaCompatResult = validateDataAgainstSchema(nodeInput, node.inputSchema);

        if (!inputValidation.compatible) {
          await this._storageService.updateJobAsync(jobId, { status: "failed" });

          const errorMessage: string = `Input validation failed for node "${node.name}" (${nodeId}): ${inputValidation.errors.join(", ")}`;

          this._logger.error(errorMessage, { jobId, nodeId });

          return { success: false, output: null, error: errorMessage, nodesExecuted: 0 };
        }

        this._logger.debug(`Executing node "${node.name}"`, { jobId, nodeId, type: node.type });

        const nodeOutput: Record<string, unknown> = await this._executeNodeAsync(node, nodeInput);

        const outputValidation: ISchemaCompatResult = validateDataAgainstSchema(nodeOutput, node.outputSchema);

        if (!outputValidation.compatible) {
          await this._storageService.updateJobAsync(jobId, { status: "failed" });

          const errorMessage: string = `Output validation failed for node "${node.name}" (${nodeId}): ${outputValidation.errors.join(", ")}`;

          this._logger.error(errorMessage, { jobId, nodeId });

          return { success: false, output: null, error: errorMessage, nodesExecuted: 0 };
        }

        nodeOutputs.set(nodeId, nodeOutput);
      }

      const lastNodeId: string = executionOrder[executionOrder.length - 1];
      const lastOutput: Record<string, unknown> | undefined = nodeOutputs.get(lastNodeId);

      await this._storageService.updateJobAsync(jobId, { status: "completed" });

      this._logger.info("Job execution completed", { jobId, nodesExecuted: executionOrder.length });

      return { success: true, output: lastOutput ?? null, error: null, nodesExecuted: executionOrder.length };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);

      this._logger.error("Job execution failed", { jobId, error: errorMessage });

      try {
        await this._storageService.updateJobAsync(jobId, { status: "failed" });
      } catch {
        // Ignore update errors during failure handling
      }

      return { success: false, output: null, error: errorMessage, nodesExecuted: 0 };
    }
  }

  public async runNodeTestsAsync(
    jobId: string,
    nodeId: string,
  ): Promise<{ results: INodeTestResult[]; allPassed: boolean }> {
    const testCases: INodeTestCase[] = await this._storageService.getTestCasesAsync(jobId, nodeId);
    const node: INode | null = await this._storageService.getNodeAsync(jobId, nodeId);

    if (!node) {
      throw new Error(`Node not found: ${nodeId} in job ${jobId}`);
    }

    const results: INodeTestResult[] = [];

    for (const testCase of testCases) {
      const startTime: number = Date.now();

      try {
        const output: Record<string, unknown> = await this._executeNodeAsync(node, testCase.inputData);
        const executionTimeMs: number = Date.now() - startTime;

        const outputValidation: ISchemaCompatResult = validateDataAgainstSchema(output, node.outputSchema);

        const result: INodeTestResult = {
          testId: testCase.testId,
          passed: outputValidation.compatible,
          output,
          error: null,
          validationErrors: outputValidation.errors,
          executionTimeMs,
        };

        results.push(result);
      } catch (error: unknown) {
        const executionTimeMs: number = Date.now() - startTime;
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        const result: INodeTestResult = {
          testId: testCase.testId,
          passed: false,
          output: null,
          error: errorMessage,
          validationErrors: [],
          executionTimeMs,
        };

        results.push(result);
      }
    }

    const allPassed: boolean = results.every((r: INodeTestResult) => r.passed);

    return { results, allPassed };
  }

  //#endregion Public methods

  //#region Private methods

  private async _executeNodeAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const nodeType: NodeType = node.type;

    switch (nodeType) {
      case "manual":
        return input;

      case "python_code":
        return this._executePythonAsync(node, input);

      case "curl_fetcher":
      case "crawl4ai":
      case "searxng":
        return { error: "Node type not yet implemented", type: node.type };

      case "output_to_ai":
      case "agent":
        return { error: "Agent node execution requires AI provider setup", type: node.type };

      default:
        throw new Error(`Unsupported node type: ${nodeType}`);
    }
  }

  private async _executePythonAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const pythonConfig: IPythonCodeConfig = node.config as IPythonCodeConfig;
    const inputBase64: string = Buffer.from(JSON.stringify(input)).toString("base64");

    const wrappedCode: string = [
      "import sys, json, os, base64",
      "input_data = json.loads(base64.b64decode(os.environ['BETTERCLAW_INPUT']).decode('utf-8'))",
      pythonConfig.code,
    ].join("\n");

    const { stdout, stderr } = await _execAsync(
      `${pythonConfig.pythonPath || "python3"} -c ${JSON.stringify(wrappedCode)}`,
      {
        timeout: pythonConfig.timeout || DEFAULT_PYTHON_TIMEOUT_MS,
        env: { ...process.env, BETTERCLAW_INPUT: inputBase64 },
      },
    );

    const parsed: Record<string, unknown> = JSON.parse(stdout.trim()) as Record<string, unknown>;

    if (stderr) {
      parsed._stderr = stderr;
    }

    return parsed;
  }

  //#endregion Private methods
}
