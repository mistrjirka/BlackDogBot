import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ToolLoopAgent, ToolSet, LanguageModel, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";

import {
  IJob,
  INode,
  INodeTestCase,
  INodeTestResult,
  IJobExecutionResult,
  IPythonCodeConfig,
  ICurlFetcherConfig,
  ICrawl4AiConfig,
  ISearxngConfig,
  IRssFetcherConfig,
  IRssState,
  IOutputToAiConfig,
  IAgentNodeConfig,
  ILiteSqlConfig,
  ILiteSqlReaderConfig,
  IAgentToolCall,
  NodeType,
  OnNodeProgressCallback,
} from "../shared/types/index.js";
import { DEFAULT_PYTHON_TIMEOUT_MS, DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { LoggerService } from "./logger.service.js";
import { JobStorageService } from "./job-storage.service.js";
import * as rssState from "../helpers/rss-state.js";
import { AiProviderService } from "./ai-provider.service.js";
import { searchSearxngAsync } from "../utils/searxng-client.js";
import { crawlUrlAsync } from "../utils/crawl4ai-client.js";
import * as litesql from "../helpers/litesql.js";
import { StatusService } from "./status.service.js";
import { getExecutionOrder } from "../jobs/graph.js";
import { ConfigService } from "./config.service.js";
import { getCurrentDateTime } from "../utils/time.js";
import { validateDataAgainstSchema, ISchemaCompatResult } from "../jobs/schema-compat.js";
import { generateTextWithRetryAsync, generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { wrapToolSetWithReasoning } from "../utils/tool-reasoning-wrapper.js";
import { parseRssFeed } from "../utils/rss-parser.js";
import { createOutputZodSchema } from "../utils/json-schema-to-zod.js";
import { thinkTool } from "../tools/index.js";
import {
  createAgentNodeToolPool,
  type AgentNodeMessageSender,
} from "../utils/agent-node-tool-pool.js";
import { extractErrorMessage } from "../utils/error.js";

// Default timeout for HTTP requests in node execution (30 seconds)
const DEFAULT_FETCH_TIMEOUT_MS: number = 30000;

/**
 * Fetch with timeout using AbortController.
 * Throws a timeout error if the request takes longer than timeoutMs.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller: AbortController = new AbortController();
  const timeoutId: NodeJS.Timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response: Response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

const _execAsync: typeof exec.__promisify__ = promisify(exec);

export interface IJobExecutionOptions {
  agentNodeMessageSender?: AgentNodeMessageSender;
  allowCreatingStatus?: boolean;
  preserveStatus?: boolean;
}

export class JobExecutorService {
  //#region Data members

  private static _instance: JobExecutorService | null;
  private _logger: LoggerService;
  private _storageService: JobStorageService;
  private _runningJobs: Set<string> = new Set<string>();
  private _lastToolCallHistory: IAgentToolCall[] = [];

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
    onNodeProgressAsync?: OnNodeProgressCallback,
    options?: IJobExecutionOptions,
  ): Promise<IJobExecutionResult> {
    // Check if job is already running (in-memory lock to prevent concurrent execution)
    if (this._runningJobs.has(jobId)) {
      throw new Error(`Job "${jobId}" is already running. Concurrent execution is not allowed.`);
    }

    // Acquire lock
    this._runningJobs.add(jobId);

    const statusService: StatusService = StatusService.getInstance();
    const startTime: number = Date.now();
    const nodeResults: NonNullable<IJobExecutionResult["nodeResults"]> = [];

    try {
      const job: IJob | null = await this._storageService.getJobAsync(jobId);

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      const allowCreatingStatus: boolean = options?.allowCreatingStatus === true;
      const preserveStatus: boolean = options?.preserveStatus === true;
      const canExecute: boolean = job.status === "ready" || (allowCreatingStatus && job.status === "creating");

      if (!canExecute) {
        throw new Error(`Job "${jobId}" is not ready for execution. Current status: ${job.status}`);
      }

      if (!preserveStatus) {
        await this._storageService.updateJobAsync(jobId, { status: "running" });
      }

      statusService.setStatus("job_execution", `Running job: ${job.name}`, { jobId });

      this._logger.info("Job execution started", { jobId });

      const nodes: INode[] = await this._storageService.listNodesAsync(jobId);
      const executionOrder: string[] = getExecutionOrder(nodes, job.entrypointNodeId!);

      const nodeMap: Map<string, INode> = new Map<string, INode>();

      for (const node of nodes) {
        nodeMap.set(node.nodeId, node);
      }

      const nodeOutputs: Map<string, Record<string, unknown>> = new Map<string, Record<string, unknown>>();
      let nodesExecuted: number = 0;

      for (const nodeId of executionOrder) {
        const node: INode | undefined = nodeMap.get(nodeId);

        if (!node) {
          throw new Error(`Node "${nodeId}" not found during execution`);
        }

        // Update status for current node
        statusService.setStatus("job_execution", `Executing: ${node.name}`, {
          jobId,
          nodeId,
          nodeType: node.type,
          progress: `${nodesExecuted + 1}/${executionOrder.length}`,
        });

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
          if (!preserveStatus) {
            await this._storageService.updateJobAsync(jobId, { status: "failed" });
          }

          nodeResults.push({
            nodeId: node.nodeId,
            nodeName: node.name,
            duration: 0,
            status: "failed",
            input: nodeInput,
            passedToNodeIds: [...node.connections],
            error: `Input validation failed: ${inputValidation.errors.join(", ")}`,
          });

          const errorMessage: string = `Input validation failed for node "${node.name}" (${nodeId}): ${inputValidation.errors.join(", ")}`;

          this._logger.error(errorMessage, { jobId, nodeId, nodeType: node.type });
          statusService.clearStatus();

          return {
            success: false,
            output: null,
            error: errorMessage,
            nodesExecuted,
            failedNodeId: nodeId,
            failedNodeName: node.name,
            timing: {
              startedAt: startTime,
              completedAt: Date.now(),
              durationMs: Date.now() - startTime,
            },
            nodeResults: nodeResults,
          };
        }

        this._logger.debug(`Executing node "${node.name}"`, { jobId, nodeId, type: node.type });

        let nodeOutput: Record<string, unknown>;
        const nodeStartTime: number = Date.now();

        try {
          try {
            await onNodeProgressAsync?.({ jobId, nodeId, nodeName: node.name, status: "executing" });
          } catch {
            // Progress errors must never affect execution
          }

          nodeOutput = await this._executeNodeAsync(node, nodeInput, options);

          const nodeEndTime: number = Date.now();
          nodeResults.push({
            nodeId: node.nodeId,
            nodeName: node.name,
            duration: nodeEndTime - nodeStartTime,
            status: "completed",
            input: nodeInput,
            output: nodeOutput,
            passedToNodeIds: [...node.connections],
          });

          try {
            await onNodeProgressAsync?.({ jobId, nodeId, nodeName: node.name, status: "completed" });
          } catch {
            // Progress errors must never affect execution
          }
        } catch (nodeError: unknown) {
          try {
            await onNodeProgressAsync?.({ jobId, nodeId, nodeName: node.name, status: "failed" });
          } catch {
            // Progress errors must never affect execution
          }

          const rawMessage: string = nodeError instanceof Error ? nodeError.message : String(nodeError);
          const errorMessage: string = `Node "${node.name}" (${nodeId}, type: ${node.type}) failed: ${rawMessage}`;

          const nodeEndTime: number = Date.now();
          nodeResults.push({
            nodeId: node.nodeId,
            nodeName: node.name,
            duration: nodeEndTime - nodeStartTime,
            status: "failed",
            input: nodeInput,
            passedToNodeIds: [...node.connections],
            error: rawMessage,
          });

          this._logger.error(errorMessage, { jobId, nodeId, nodeType: node.type });

          if (!preserveStatus) {
            await this._storageService.updateJobAsync(jobId, { status: "failed" });
          }

          return {
            success: false,
            output: null,
            error: errorMessage,
            nodesExecuted,
            failedNodeId: nodeId,
            failedNodeName: node.name,
            timing: {
              startedAt: startTime,
              completedAt: Date.now(),
              durationMs: Date.now() - startTime,
            },
            nodeResults: nodeResults,
          };
        }

        nodesExecuted++;

        const outputValidation: ISchemaCompatResult = validateDataAgainstSchema(nodeOutput, node.outputSchema);

        if (!outputValidation.compatible) {
          if (!preserveStatus) {
            await this._storageService.updateJobAsync(jobId, { status: "failed" });
          }

          nodeResults.push({
            nodeId: node.nodeId,
            nodeName: node.name,
            duration: 0,
            status: "failed",
            input: nodeInput,
            output: nodeOutput,
            passedToNodeIds: [...node.connections],
            error: `Output validation failed: ${outputValidation.errors.join(", ")}`,
          });

          const errorMessage: string = `Output validation failed for node "${node.name}" (${nodeId}): ${outputValidation.errors.join(", ")}`;

          this._logger.error(errorMessage, { jobId, nodeId, nodeType: node.type });

          return {
            success: false,
            output: null,
            error: errorMessage,
            nodesExecuted,
            failedNodeId: nodeId,
            failedNodeName: node.name,
            timing: {
              startedAt: startTime,
              completedAt: Date.now(),
              durationMs: Date.now() - startTime,
            },
            nodeResults: nodeResults,
          };
        }

        nodeOutputs.set(nodeId, nodeOutput);
      }

      const lastNodeId: string = executionOrder[executionOrder.length - 1];
      const lastOutput: Record<string, unknown> | undefined = nodeOutputs.get(lastNodeId);

      if (!preserveStatus) {
        await this._storageService.updateJobAsync(jobId, { status: "completed" });
      }

      this._logger.info("Job execution completed", { jobId, nodesExecuted: executionOrder.length });

      return {
        success: true,
        output: lastOutput ?? null,
        error: null,
        nodesExecuted: executionOrder.length,
        failedNodeId: null,
        failedNodeName: null,
        timing: {
          startedAt: startTime,
          completedAt: Date.now(),
          durationMs: Date.now() - startTime,
        },
        nodeResults: nodeResults,
      };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);

      this._logger.error("Job execution failed", { jobId, error: errorMessage });

      if (!options?.preserveStatus) {
        try {
          await this._storageService.updateJobAsync(jobId, { status: "failed" });
        } catch {
          // Ignore update errors during failure handling
        }
      }

      return {
        success: false,
        output: null,
        error: errorMessage,
        nodesExecuted: 0,
        failedNodeId: null,
        failedNodeName: null,
        timing: {
          startedAt: startTime,
          completedAt: Date.now(),
          durationMs: Date.now() - startTime,
        },
        nodeResults: nodeResults,
      };
    } finally {
      // Release lock
      this._runningJobs.delete(jobId);

      // Clear status
      StatusService.getInstance().clearStatus();
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
          toolCallHistory: this._lastToolCallHistory.length > 0 ? [...this._lastToolCallHistory] : undefined,
        };

        results.push(result);
      } catch (error: unknown) {
        const executionTimeMs: number = Date.now() - startTime;
        const errorMessage: string = extractErrorMessage(error);

        const result: INodeTestResult = {
          testId: testCase.testId,
          passed: false,
          output: null,
          error: errorMessage,
          validationErrors: [],
          executionTimeMs,
          toolCallHistory: this._lastToolCallHistory.length > 0 ? [...this._lastToolCallHistory] : undefined,
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
    options?: IJobExecutionOptions,
  ): Promise<Record<string, unknown>> {
    const nodeType: NodeType = node.type;

    switch (nodeType) {
      case "start":
        return input;

      case "python_code":
        return this._executePythonAsync(node, input);

      case "curl_fetcher":
        return this._executeCurlFetcherAsync(node, input);

      case "crawl4ai":
        return this._executeCrawl4AiAsync(node, input);

      case "searxng":
        return this._executeSearxngAsync(node, input);

      case "rss_fetcher":
        return this._executeRssFetcherAsync(node, input);

      case "output_to_ai":
        return this._executeOutputToAiAsync(node, input);

      case "agent":
        return this._executeAgentAsync(node, input, options);

      case "litesql":
        return this._executeLiteSqlAsync(node, input);

      case "litesql_reader":
        return this._executeLiteSqlReaderAsync(node, input);

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

    // Write code to a temp file to avoid shell escaping issues with python3 -c
    const tmpFile: string = path.join(os.tmpdir(), `betterclaw-py-${node.nodeId}-${Date.now()}.py`);

    try {
      await fs.writeFile(tmpFile, wrappedCode, "utf-8");

      const { stdout, stderr } = await _execAsync(
        `${pythonConfig.pythonPath || "python3"} ${JSON.stringify(tmpFile)}`,
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
    } finally {
      // Clean up the temp file
      try {
        await fs.unlink(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private async _executeCurlFetcherAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: ICurlFetcherConfig = node.config as ICurlFetcherConfig;

    let url: string = config.url;

    // Allow template substitution from input: {{key}} -> input[key]
    for (const [key, value] of Object.entries(input)) {
      url = url.replaceAll(`{{${key}}}`, String(value));
    }

    const fetchOptions: RequestInit = {
      method: config.method || "GET",
      headers: config.headers || {},
    };

    if (config.body) {
      let body: string = config.body;

      for (const [key, value] of Object.entries(input)) {
        body = body.replaceAll(`{{${key}}}`, String(value));
      }

      fetchOptions.body = body;
    }

    this._logger.debug("Executing curl_fetcher node", { url, method: fetchOptions.method });

    const response: Response = await fetchWithTimeout(url, fetchOptions);
    const responseText: string = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP request failed (${response.status} ${response.statusText}): ${responseText}`);
    }

    let responseBody: unknown;

    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }

    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };
  }

  private async _executeCrawl4AiAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: ICrawl4AiConfig = node.config as ICrawl4AiConfig;

    let url: string = config.url;

    for (const [key, value] of Object.entries(input)) {
      url = url.replaceAll(`{{${key}}}`, String(value));
    }

    this._logger.debug("Executing crawl4ai node", { url });

    const crawlResult = await crawlUrlAsync(url, {
      selector: config.selector ?? undefined,
      cacheMode: "bypass",
    });

    const output: Record<string, unknown> = {
      url,
      success: crawlResult.success,
      markdown: crawlResult.markdown,
      html: crawlResult.html,
    };

    // If extraction prompt is provided, run AI extraction on the markdown content
    if (config.extractionPrompt && crawlResult.markdown) {
      const aiProviderService: AiProviderService = AiProviderService.getInstance();
      const model: LanguageModel = aiProviderService.getDefaultModel();

      const outputSchema: Record<string, unknown> | undefined = node.outputSchema as Record<string, unknown> | undefined;
      const outputProperties: Record<string, unknown> | undefined = outputSchema?.properties as Record<string, unknown> | undefined;
      const extractedSchema: Record<string, unknown> | undefined = outputProperties?.extracted as Record<string, unknown> | undefined;
      const extractedType: unknown = extractedSchema?.type;
      const extractedProperties: unknown = extractedSchema?.properties;
      const shouldUseStructuredExtraction: boolean =
        !!extractedSchema &&
        extractedType === "object" &&
        typeof extractedProperties === "object" &&
        extractedProperties !== null;

      if (shouldUseStructuredExtraction) {
        const extractionResult = await generateObjectWithRetryAsync({
          model,
          prompt: `${config.extractionPrompt}\n\nContent:\n${crawlResult.markdown}`,
          schema: createOutputZodSchema(extractedSchema),
          retryOptions: { callType: "job_execution" },
        });

        output.extracted = extractionResult.object as Record<string, unknown>;
      } else {
        const extractionResult = await generateTextWithRetryAsync({
          model,
          prompt: `${config.extractionPrompt}\n\nContent:\n${crawlResult.markdown}`,
          retryOptions: { callType: "job_execution" },
        });

        output.extracted = extractionResult.text;
      }
    }

    return output;
  }

  private async _executeSearxngAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: ISearxngConfig = node.config as ISearxngConfig;

    let query: string = config.query;

    for (const [key, value] of Object.entries(input)) {
      query = query.replaceAll(`{{${key}}}`, String(value));
    }

    this._logger.debug("Executing searxng node", { query });

    const searchResult = await searchSearxngAsync(query, {
      categories: config.categories,
      maxResults: config.maxResults,
    });

    const maxResults: number = config.maxResults || 10;
    const trimmedResults = searchResult.results.slice(0, maxResults);

    return {
      query,
      results: trimmedResults,
      totalResults: searchResult.number_of_results,
    };
  }

  private async _executeRssFetcherAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: IRssFetcherConfig = node.config as IRssFetcherConfig;

    let url: string = config.url;

    for (const [key, value] of Object.entries(input)) {
      url = url.replaceAll(`{{${key}}}`, String(value));
    }

    this._logger.debug("Executing rss_fetcher node", { url, mode: config.mode });

    const response: Response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          "Accept": "application/rss+xml, application/xml, application/atom+xml, text/xml",
          "User-Agent": "BetterClaw/1.0",
        },
      },
    );

    if (!response.ok) {
      const errorText: string = await response.text();
      throw new Error(`RSS fetch failed (${response.status}): ${errorText}`);
    }

    const xmlText: string = await response.text();
    const parsed: Record<string, unknown> = parseRssFeed(xmlText);

    const maxItems: number = config.maxItems || 20;
    const mode: string = config.mode || "latest";
    const allItems: Record<string, unknown>[] = (parsed.items ?? []) as Record<string, unknown>[];

    let returnedItems: Record<string, unknown>[];
    let unseenCount: number | undefined;

    if (mode === "unseen") {
      const state: IRssState | null = await rssState.loadRssStateAsync(url);
      const unseenItems: Record<string, unknown>[] = rssState.filterUnseenRssItems(allItems, state);

      unseenCount = unseenItems.length;
      returnedItems = unseenItems.slice(0, maxItems);

      const updatedSeenIds: string[] = rssState.mergeRssSeenIds(
        state?.seenIds ?? [],
        allItems,
      );

      await rssState.saveRssStateAsync(url, updatedSeenIds);
    } else {
      returnedItems = allItems.slice(0, maxItems);
    }

    const output: Record<string, unknown> = {
      title: parsed.title,
      description: parsed.description,
      link: parsed.link,
      items: returnedItems,
      totalItems: allItems.length,
      feedUrl: url,
      mode,
    };

    if (unseenCount !== undefined) {
      output.unseenCount = unseenCount;
    }

    return output;
  }

  private async _executeOutputToAiAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: IOutputToAiConfig = node.config as IOutputToAiConfig;
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel(config.model ?? undefined);

    const fullPrompt: string = [
      config.prompt,
      "",
      "Input data:",
      JSON.stringify(input, null, 2),
    ].join("\n");

    this._logger.debug("Executing output_to_ai node", { promptLength: fullPrompt.length });

    // Convert JSON Schema to Zod schema for guaranteed valid output
    const zodSchema = createOutputZodSchema(node.outputSchema);

    const result = await generateObjectWithRetryAsync({
      model,
      prompt: fullPrompt,
      schema: zodSchema,
      retryOptions: { callType: "job_execution" },
    });

    return result.object as Record<string, unknown>;
  }

  private async _executeAgentAsync(
    node: INode,
    input: Record<string, unknown>,
    options?: IJobExecutionOptions,
  ): Promise<Record<string, unknown>> {
    // Clear tool call history at the start of each execution
    this._lastToolCallHistory = [];

    const config: IAgentNodeConfig = node.config as IAgentNodeConfig;
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel(config.model ?? undefined);
    const maxSteps: number = config.maxSteps || DEFAULT_AGENT_MAX_STEPS;

    if (!Array.isArray(config.selectedTools) || config.selectedTools.length === 0) {
      throw new Error(`Agent node "${node.nodeId}" must specify at least one selected tool.`);
    }

    // Build the tool set from selected tools
    const toolPool: Record<string, ToolSet[string]> = createAgentNodeToolPool(
      this._logger,
      options?.agentNodeMessageSender,
    );
    const selectedTools: ToolSet = {};

    for (const toolName of config.selectedTools) {
      if (toolName === 'done' || toolName === 'think') continue;

      if (toolPool[toolName]) {
        selectedTools[toolName] = toolPool[toolName];
      } else {
        this._logger.warn(`Agent node requested unknown tool: ${toolName}`, { nodeId: node.nodeId });
      }
    }

    // Always ensure think is available for the agent, regardless of selectedTools config
    if (!selectedTools.think) {
      selectedTools.think = thinkTool;
    }

    // Add the done tool
    // Create dynamic Zod schema from node's outputSchema for strong validation
    const outputZodSchema: z.ZodType<Record<string, unknown>> = createOutputZodSchema(node.outputSchema);

    const doneTool = tool({
      description: "Call this when the task is complete. Return the final result as JSON matching the expected output schema.",
      inputSchema: z.object({
        result: outputZodSchema
          .describe("The final output of this agent node. Must match the expected output schema."),
      }),
      execute: async (_input: { result: Record<string, unknown> }): Promise<{ finished: boolean }> => {
        return { finished: true };
      },
    });

    selectedTools.done = doneTool;

    // Build instructions with output schema if provided
    let outputSchemaInstructions: string = "";

    if (node.outputSchema) {
      outputSchemaInstructions = `\n\n## Expected Output Schema\nYour output must match this JSON schema:\n\`\`\`json\n${JSON.stringify(node.outputSchema, null, 2)}\n\`\`\`\n\nMake sure your "done" tool call returns a result object that conforms to this schema.`;
    }

    const currentDateTime: string = getCurrentDateTime(
      ConfigService.getInstance().getConfig().scheduler?.timezone,
    );
    const instructions: string = `Current date and time: ${currentDateTime}\n\n${config.systemPrompt}${outputSchemaInstructions}\n\n## Input Data\nYou have been given the following input data:\n${JSON.stringify(input, null, 2)}\n\nWhen you are done, call the "done" tool with your final result as a JSON object.`;

    this._logger.debug("Executing agent node", { nodeId: node.nodeId, toolCount: Object.keys(selectedTools).length, maxSteps, reasoningEffort: config.reasoningEffort });

    // Enable tool result compaction to prevent oversized tool results from causing context overflow
    const wrappedTools: ToolSet = wrapToolSetWithReasoning(selectedTools, {
      enableResultCompaction: true,
      compactionOptions: {
        maxTokens: 10000,
        representativeArraySize: 5,
      },
      logger: this._logger,
    });

    const agent: ToolLoopAgent = new ToolLoopAgent({
      model,
      instructions,
      tools: wrappedTools,
      stopWhen: [
        hasToolCall("done"),
        stepCountIs(maxSteps),
      ],
      experimental_repairToolCall: repairToolCallJsonAsync,
      maxRetries: config.reasoningEffort === "high" ? 3 : config.reasoningEffort === "medium" ? 2 : 1,
    });

    const agentResult = await agent.generate({ prompt: "Begin the task." });

    // Extract the result from the done tool call
    let output: Record<string, unknown> = {};

    if (agentResult.steps) {
      for (const step of agentResult.steps) {
        if (step.toolCalls) {
          for (const toolCall of step.toolCalls) {
            if (toolCall.toolName === "done" && toolCall.input) {
              const inputData: Record<string, unknown> = toolCall.input as Record<string, unknown>;
              output = (inputData.result ?? inputData) as Record<string, unknown>;
            }
          }
        }
      }
    }

    // Build tool call history (excluding 'done' tool)
    if (agentResult.steps) {
      for (const step of agentResult.steps) {
        if (step.toolCalls) {
          for (let i = 0; i < step.toolCalls.length; i++) {
            const toolCall = step.toolCalls[i];
            if (toolCall.toolName !== "done") {
              // Get the corresponding step result if available
              const toolResult = step.toolResults?.[i];
              let stepResult: unknown = null;
              if (toolResult && typeof toolResult === "object") {
                const tr = toolResult as Record<string, unknown>;
                // Handle LanguageModelV3ToolResultOutput format
                if (tr.output !== undefined) {
                  const outputObj = tr.output as Record<string, unknown>;
                  if (outputObj && typeof outputObj === "object" && outputObj.value !== undefined) {
                    stepResult = outputObj.value;
                  } else {
                    stepResult = tr.output;
                  }
                }
              }
              this._lastToolCallHistory.push({
                toolName: toolCall.toolName,
                input: toolCall.input as Record<string, unknown>,
                output: stepResult,
              });
            }
          }
        }
      }
    }

    if (Object.keys(output).length === 0) {
      throw new Error(
        `Agent node "${node.nodeId}" completed without calling the done tool. ` +
        `Ensure the agent returns output via done with a result matching the output schema.`,
      );
    }

    return output;
  }


  private async _executeLiteSqlAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: ILiteSqlConfig = node.config as ILiteSqlConfig;

    const databaseName: string = this._substituteTemplate(config.databaseName, input);
    const tableName: string = this._substituteTemplate(config.tableName, input);

    const dbExists: boolean = await litesql.databaseExistsAsync(databaseName);
    if (!dbExists) {
      const allDbs = await litesql.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      throw new Error(
        `Database "${databaseName}" does not exist.\n` +
          `Available databases: ${available}\n` +
          `Use create_database tool to create a new database.`,
      );
    }

    const tableExists: boolean = await litesql.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const tables = await litesql.listTablesAsync(databaseName);
      const available: string = tables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${databaseName}".\n` +
          `Available tables: ${available}\n` +
          `Use create_table tool to create a new table.`,
      );
    }

    const schema = await litesql.getTableSchemaAsync(databaseName, tableName);
    const tableColumns: string[] = schema.columns.map((c) => c.name);

    // Auto-unwrap if input is a wrapper object containing an array
    // Handles patterns like: { items: [...] }, { data: [...] }, { results: [...] }
    // Also handles: { items: [...], count: N } by finding the array key
    const inputKeys: string[] = Object.keys(input);
    let dataToInsert: Record<string, unknown> | Record<string, unknown>[] = input;
    let itemsToValidate: Record<string, unknown>[] = [input];

    // Common key names that typically contain arrays of items
    const arrayKeyHints: string[] = ["items", "data", "results", "rows", "records", "entries"];

    // Find the first key that contains an array
    const arrayKey: string | undefined = inputKeys.find((key) => {
      const value: unknown = input[key];
      if (Array.isArray(value)) {
        // If it's one of the hint keys, use it immediately
        if (arrayKeyHints.includes(key)) {
          return true;
        }
        // If there's only one key total, use it
        if (inputKeys.length === 1) {
          return true;
        }
        // If the array has at least one item that looks like a data row (object, not primitive)
        const arr: unknown[] = value;
        if (arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && !Array.isArray(arr[0])) {
          return true;
        }
      }
      return false;
    });

    if (arrayKey !== undefined) {
      dataToInsert = input[arrayKey] as Record<string, unknown>[];
      itemsToValidate = dataToInsert;
    }

    if (itemsToValidate.length === 0) {
      return { insertedCount: 0, lastRowId: 0 };
    }

    for (const item of itemsToValidate) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`Expected object to insert into "${tableName}", but got: ${JSON.stringify(item)}`);
      }

      const itemKeys: string[] = Object.keys(item);
      const missingColumns: string[] = tableColumns.filter((col) => {
        const colInfo = schema.columns.find((c) => c.name === col);
        return colInfo && colInfo.notNull && !itemKeys.includes(col) && !colInfo.primaryKey;
      });

      if (missingColumns.length > 0) {
        throw new Error(
          `Schema mismatch for table "${tableName}":\n` +
            `Table columns: ${schema.columns.map((c) => `${c.name} (${c.type}${c.primaryKey ? " PK" : ""})`).join(", ")}\n` +
            `Input provided: ${JSON.stringify(item)}\n\n` +
            `Missing required columns: ${missingColumns.join(", ")}\n\n` +
            `Option 1: Edit the previous node to output the required columns.\n` +
            `Option 2: Create/modify table with create_table.`,
        );
      }

      const extraKeys: string[] = itemKeys.filter((key) => !tableColumns.includes(key));
      if (extraKeys.length > 0 && tableColumns.length > 0) {
        this._logger.warn("Input contains extra columns not in table", {
          table: tableName,
          extraColumns: extraKeys,
          tableColumns,
        });
      }
    }

    try {
      const result = await litesql.insertIntoTableAsync(databaseName, tableName, dataToInsert);

      return {
        insertedCount: result.insertedCount,
        lastRowId: result.lastRowId,
      };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);

      if (errorMessage.includes("UNIQUE constraint failed") || errorMessage.includes("duplicate key")) {
        throw new Error(
          `Insert failed: duplicate key violates unique constraint in table "${tableName}".\n` +
            `Input: ${JSON.stringify(input)}\n\n` +
            `Edit the previous node to generate a unique primary key or use a different primary key strategy.`,
        );
      }

      throw error;
    }
  }

  private _substituteTemplate(template: string, input: Record<string, unknown>): string {
    let result: string = template;

    for (const [key, value] of Object.entries(input)) {
      result = result.replaceAll(`{{${key}}}`, String(value));
    }

    return result;
  }

  private async _executeLiteSqlReaderAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: ILiteSqlReaderConfig = node.config as ILiteSqlReaderConfig;

    const databaseName: string = this._substituteTemplate(config.databaseName, input);
    const tableName: string = this._substituteTemplate(config.tableName, input);

    const dbExists: boolean = await litesql.databaseExistsAsync(databaseName);
    if (!dbExists) {
      const allDbs = await litesql.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      throw new Error(
        `Database "${databaseName}" does not exist.\n` +
          `Available databases: ${available}`,
      );
    }

    const tableExists: boolean = await litesql.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const tables = await litesql.listTablesAsync(databaseName);
      const available: string = tables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${databaseName}".\n` +
          `Available tables: ${available}`,
      );
    }

    const where: string | undefined = config.where
      ? this._substituteTemplate(config.where, input)
      : undefined;

    const result = await litesql.queryTableAsync(databaseName, tableName, {
      where,
      orderBy: config.orderBy ?? undefined,
      limit: config.limit ?? undefined,
    });

    return {
      rows: result.rows,
      totalCount: result.totalCount,
    };
  }

  //#endregion Private methods
}
