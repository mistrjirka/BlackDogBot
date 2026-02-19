import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ToolLoopAgent, ToolSet, LanguageModel, hasToolCall, tool } from "ai";
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
  NodeType,
} from "../shared/types/index.js";
import { DEFAULT_PYTHON_TIMEOUT_MS, DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { LoggerService } from "./logger.service.js";
import { JobStorageService } from "./job-storage.service.js";
import { RssStateService } from "./rss-state.service.js";
import { ConfigService } from "./config.service.js";
import { AiProviderService } from "./ai-provider.service.js";
import { getExecutionOrder } from "../jobs/graph.js";
import { validateDataAgainstSchema } from "../jobs/schema-compat.js";
import { ISchemaCompatResult } from "../jobs/schema-compat.js";
import { generateTextWithRetryAsync } from "../utils/llm-retry.js";
import { parseRssFeed } from "../utils/rss-parser.js";
import {
  thinkTool,
  runCmdTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
} from "../tools/index.js";

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
  ): Promise<IJobExecutionResult> {
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
      let nodesExecuted: number = 0;

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

          this._logger.error(errorMessage, { jobId, nodeId, nodeType: node.type });

          return { success: false, output: null, error: errorMessage, nodesExecuted, failedNodeId: nodeId, failedNodeName: node.name };
        }

        this._logger.debug(`Executing node "${node.name}"`, { jobId, nodeId, type: node.type });

        let nodeOutput: Record<string, unknown>;

        try {
          nodeOutput = await this._executeNodeAsync(node, nodeInput);
        } catch (nodeError: unknown) {
          const rawMessage: string = nodeError instanceof Error ? nodeError.message : String(nodeError);
          const errorMessage: string = `Node "${node.name}" (${nodeId}, type: ${node.type}) failed: ${rawMessage}`;

          this._logger.error(errorMessage, { jobId, nodeId, nodeType: node.type });

          await this._storageService.updateJobAsync(jobId, { status: "failed" });

          return { success: false, output: null, error: errorMessage, nodesExecuted, failedNodeId: nodeId, failedNodeName: node.name };
        }

        nodesExecuted++;

        const outputValidation: ISchemaCompatResult = validateDataAgainstSchema(nodeOutput, node.outputSchema);

        if (!outputValidation.compatible) {
          await this._storageService.updateJobAsync(jobId, { status: "failed" });

          const errorMessage: string = `Output validation failed for node "${node.name}" (${nodeId}): ${outputValidation.errors.join(", ")}`;

          this._logger.error(errorMessage, { jobId, nodeId, nodeType: node.type });

          return { success: false, output: null, error: errorMessage, nodesExecuted, failedNodeId: nodeId, failedNodeName: node.name };
        }

        nodeOutputs.set(nodeId, nodeOutput);
      }

      const lastNodeId: string = executionOrder[executionOrder.length - 1];
      const lastOutput: Record<string, unknown> | undefined = nodeOutputs.get(lastNodeId);

      await this._storageService.updateJobAsync(jobId, { status: "completed" });

      this._logger.info("Job execution completed", { jobId, nodesExecuted: executionOrder.length });

      return { success: true, output: lastOutput ?? null, error: null, nodesExecuted: executionOrder.length, failedNodeId: null, failedNodeName: null };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);

      this._logger.error("Job execution failed", { jobId, error: errorMessage });

      try {
        await this._storageService.updateJobAsync(jobId, { status: "failed" });
      } catch {
        // Ignore update errors during failure handling
      }

      return { success: false, output: null, error: errorMessage, nodesExecuted: 0, failedNodeId: null, failedNodeName: null };
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
        return this._executeAgentAsync(node, input);

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

    const response: Response = await fetch(url, fetchOptions);
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
    const configService: ConfigService = ConfigService.getInstance();
    const servicesConfig = configService.getConfig().services;

    let url: string = config.url;

    for (const [key, value] of Object.entries(input)) {
      url = url.replaceAll(`{{${key}}}`, String(value));
    }

    const crawlRequestBody: Record<string, unknown> = {
      urls: [url],
      crawler_config: {
        cache_mode: "bypass",
      },
    };

    if (config.selector) {
      (crawlRequestBody.crawler_config as Record<string, unknown>).css_selector = config.selector;
    }

    this._logger.debug("Executing crawl4ai node", { url });

    const response: Response = await fetch(`${servicesConfig.crawl4aiUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(crawlRequestBody),
    });

    if (!response.ok) {
      const errorText: string = await response.text();
      throw new Error(`Crawl4AI request failed (${response.status}): ${errorText}`);
    }

    const crawlResult: Record<string, unknown> = await response.json() as Record<string, unknown>;

    const results: unknown[] = (crawlResult.results ?? []) as unknown[];
    const firstResult: Record<string, unknown> = (results[0] ?? {}) as Record<string, unknown>;

    // Crawl4AI returns markdown as an object with raw_markdown, markdown_with_citations, etc.
    const markdownField: unknown = firstResult.markdown;
    let markdown: string;

    if (markdownField && typeof markdownField === "object" && (markdownField as Record<string, unknown>).raw_markdown) {
      markdown = (markdownField as Record<string, unknown>).raw_markdown as string;
    } else if (typeof markdownField === "string") {
      markdown = markdownField;
    } else {
      markdown = "";
    }

    const html: string = (typeof firstResult.html === "string" ? firstResult.html : "") as string;
    const success: boolean = (firstResult.success ?? false) as boolean;

    const output: Record<string, unknown> = {
      url,
      success,
      markdown,
      html,
    };

    // If extraction prompt is provided, run AI extraction on the markdown content
    if (config.extractionPrompt && markdown) {
      const aiProviderService: AiProviderService = AiProviderService.getInstance();
      const model: LanguageModel = aiProviderService.getDefaultModel();

      const extractionResult = await generateTextWithRetryAsync({
        model,
        prompt: `${config.extractionPrompt}\n\nContent:\n${markdown}`,
      });

      let extractedData: unknown;

      try {
        extractedData = JSON.parse(extractionResult.text.trim());
      } catch {
        extractedData = extractionResult.text;
      }

      output.extracted = extractedData;
    }

    return output;
  }

  private async _executeSearxngAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: ISearxngConfig = node.config as ISearxngConfig;
    const configService: ConfigService = ConfigService.getInstance();
    const servicesConfig = configService.getConfig().services;

    let query: string = config.query;

    for (const [key, value] of Object.entries(input)) {
      query = query.replaceAll(`{{${key}}}`, String(value));
    }

    const params: URLSearchParams = new URLSearchParams({
      q: query,
      format: "json",
    });

    if (config.categories.length > 0) {
      params.set("categories", config.categories.join(","));
    }

    this._logger.debug("Executing searxng node", { query });

    const response: Response = await fetch(`${servicesConfig.searxngUrl}/search?${params.toString()}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      const errorText: string = await response.text();
      throw new Error(`SearXNG request failed (${response.status}): ${errorText}`);
    }

    const searchResult: Record<string, unknown> = await response.json() as Record<string, unknown>;
    const allResults: unknown[] = (searchResult.results ?? []) as unknown[];

    const maxResults: number = config.maxResults || 10;
    const trimmedResults: unknown[] = allResults.slice(0, maxResults);

    return {
      query,
      results: trimmedResults,
      totalResults: allResults.length,
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

    const response: Response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/rss+xml, application/xml, application/atom+xml, text/xml",
        "User-Agent": "BetterClaw/1.0",
      },
    });

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
      const rssStateService: RssStateService = RssStateService.getInstance();
      const state: IRssState | null = await rssStateService.loadStateAsync(url);
      const unseenItems: Record<string, unknown>[] = rssStateService.filterUnseenItems(allItems, state);

      unseenCount = unseenItems.length;
      returnedItems = unseenItems.slice(0, maxItems);

      // Persist seen IDs: union of previously seen + all fetched (not just returned)
      const updatedSeenIds: string[] = rssStateService.mergeSeenIds(
        state?.seenIds ?? [],
        allItems,
      );

      await rssStateService.saveStateAsync(url, updatedSeenIds);
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

    const outputSchemaStr: string = JSON.stringify(node.outputSchema, null, 2);
    const fullPrompt: string = [
      config.prompt,
      "",
      "Input data:",
      JSON.stringify(input, null, 2),
      "",
      "Required output JSON schema:",
      outputSchemaStr,
      "",
      "IMPORTANT: Respond with ONLY raw JSON matching the schema above. Do NOT wrap it in markdown code fences. Do NOT include any text before or after the JSON.",
    ].join("\n");

    this._logger.debug("Executing output_to_ai node", { promptLength: fullPrompt.length });

    const result = await generateTextWithRetryAsync({
      model,
      prompt: fullPrompt,
    });

    const responseText: string = result.text ?? "";
    const parsed: Record<string, unknown> = this._extractJsonFromResponse(responseText);

    return parsed;
  }

  private _extractJsonFromResponse(responseText: string): Record<string, unknown> {
    const trimmed: string = responseText.trim();

    // Try direct parse first
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Continue to fallback strategies
    }

    // Try extracting from markdown code fences: ```json ... ``` or ``` ... ```
    const fenceMatch: RegExpMatchArray | null = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);

    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as Record<string, unknown>;
      } catch {
        // Continue to next fallback
      }
    }

    // Try extracting the first JSON object from the response
    const objectMatch: RegExpMatchArray | null = trimmed.match(/\{[\s\S]*\}/);

    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as Record<string, unknown>;
      } catch {
        // Fall through
      }
    }

    // Last resort: wrap raw text
    return { response: responseText };
  }

  private async _executeAgentAsync(
    node: INode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config: IAgentNodeConfig = node.config as IAgentNodeConfig;
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel(config.model ?? undefined);
    const maxSteps: number = config.maxSteps || DEFAULT_AGENT_MAX_STEPS;

    // Build the tool set from selected tools
    const toolPool: Record<string, ToolSet[string]> = this._getAgentNodeToolPool();
    const selectedTools: ToolSet = {};

    for (const toolName of config.selectedTools) {
      if (toolPool[toolName]) {
        selectedTools[toolName] = toolPool[toolName];
      } else {
        this._logger.warn(`Agent node requested unknown tool: ${toolName}`, { nodeId: node.nodeId });
      }
    }

    // Add the done tool
    const doneTool = tool({
      description: "Call this when the task is complete. Return the final result as JSON.",
      inputSchema: z.object({
        result: z.record(z.string(), z.unknown())
          .describe("The final output of this agent node as a JSON object"),
      }),
      execute: async (_input: { result: Record<string, unknown> }): Promise<{ finished: boolean }> => {
        return { finished: true };
      },
    });

    selectedTools.done = doneTool;

    const instructions: string = `${config.systemPrompt}\n\nYou have been given the following input data:\n${JSON.stringify(input, null, 2)}\n\nWhen you are done, call the "done" tool with your final result as a JSON object matching the expected output schema.`;

    this._logger.debug("Executing agent node", { nodeId: node.nodeId, toolCount: Object.keys(selectedTools).length, maxSteps });

    const agent: ToolLoopAgent = new ToolLoopAgent({
      model,
      instructions,
      tools: selectedTools,
      stopWhen: [
        hasToolCall("done"),
      ],
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

    // If no done tool result was found, try to parse the text output
    if (Object.keys(output).length === 0 && agentResult.text) {
      try {
        output = JSON.parse(agentResult.text.trim()) as Record<string, unknown>;
      } catch {
        output = { response: agentResult.text };
      }
    }

    return output;
  }

  private _getAgentNodeToolPool(): Record<string, ToolSet[string]> {
    // The agent node can use a subset of system tools.
    // We create a simple message sender that logs rather than sends to a chat.
    const logSender = async (message: string): Promise<string | null> => {
      this._logger.info("Agent node message", { message });
      return null;
    };

    return {
      think: thinkTool,
      run_cmd: runCmdTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(logSender),
    };
  }

  //#endregion Private methods
}
