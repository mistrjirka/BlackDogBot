import fs from "node:fs/promises";
import { ToolSet, LanguageModel, type ModelMessage } from "ai";

import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { LoggerService } from "../services/logger.service.js";
import { buildMainAgentPromptAsync } from "./system-prompt.js";
import { BaseAgentBase, AGENT_EMPTY_RESPONSE_RETRIES, CONTEXT_EXCEEDED_RETRIES, type IAgentResult, type OnStepCallback } from "./base-agent.js";
import { McpService } from "../services/mcp.service.js";
import { DEFAULT_AGENT_MAX_STEPS, PROMPT_JOB_CREATION_GUIDE } from "../shared/constants.js";
import {
  thinkTool,
  runCmdTool,
  runCmdInputTool,
  getCmdStatusTool,
  getCmdOutputTool,
  stopCmdTool,
  modifyPromptTool,
  listPromptsTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
  type MessageSender,
  addJobTool,
  editJobTool,
  createRemoveJobTool,
  getJobsTool,
  createRunJobTool,
  finishJobTool,
  type NodeProgressEmitter,
  createEditNodeTool,
  removeNodeTool,
  connectNodesTool,
  disconnectNodesTool,
  setEntrypointTool,
  addNodeTestTool,
  runNodeTestTool,
  getNodesTool,
  clearJobGraphTool,
  createCallSkillTool,
  getSkillFileTool,
  addCronTool,
  removeCronTool,
  listCronsTool,
  getCronTool,
  editCronTool,
  runCronTool,
  createRenderGraphTool,
  type PhotoSender,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  fetchRssTool,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  createDatabaseTool,
  createTableTool,
  dropTableTool,
  readFromDatabaseTool,
  updateDatabaseTool,
  deleteFromDatabaseTool,
  createDoneTool,
  FileReadTracker,
  JobActivityTracker,
  type IJobCreationModeTracker,
  type IJobCreationMode,
  createStartJobCreationTool,
  createFinishJobCreationTool,
  createCreateOutputSchemaTool,
  createAddCurlFetcherNodeTool,
  createAddRssFetcherNodeTool,
  createAddCrawl4aiNodeTool,
  createAddSearxngNodeTool,
  createAddPythonCodeNodeTool,
  createAddOutputToAiNodeTool,
  createAddAgentNodeTool,
  createAddLitesqlNodeTool,
  createAddLitesqlReaderNodeTool,
  searxngTool,
  crawl4aiTool,
  setJobScheduleTool,
  removeJobScheduleTool,
} from "../tools/index.js";
import { BrainInterfaceService } from "../brain-interface/service.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { PromptService } from "../services/prompt.service.js";
import { ConfigService } from "../services/config.service.js";
import { ToolHotReloadService } from "../services/tool-hot-reload.service.js";
import { isContextExceededApiError } from "../utils/context-error.js";
import { getSessionFilePath } from "../utils/paths.js";
import { apply429BackoffAsync } from "../utils/rate-limit-retry.js";
import { extractAiErrorDetails } from "../utils/ai-error.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { ChannelRegistryService } from "../services/channel-registry.service.js";
import * as toolRegistry from "../helpers/tool-registry.js";
import type { IJob, INode } from "../shared/types/index.js";
import type { IToolCallSummary } from "./base-agent.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";

//#region Constants

/** Tools that mutate the job graph — after these complete, a graph_updated event is emitted. */
const _GraphMutatingTools: Set<string> = new Set([
  "edit_node",
  "remove_node",
  "connect_nodes",
  "disconnect_nodes",
  "set_entrypoint",
  "clear_job_graph",
  "start_job_creation",
  "add_curl_fetcher_node",
  "add_rss_fetcher_node",
  "add_crawl4ai_node",
  "add_searxng_node",
  "add_python_code_node",
  "add_output_to_ai_node",
  "add_agent_node",
  "add_litesql_node",
  "add_litesql_reader_node",
  "finish_job_creation",
]);

/** Max times generate() can be restarted due to tool rebuild (create_table). */
const MAX_TOOL_REBUILD_RESTARTS: number = 2;
const MAX_429_RETRIES: number = 8;

//#endregion Constants

//#region Interfaces

interface IChatSession {
  messages: ModelMessage[];
  lastActivityAt: number;
  jobCreationMode: IJobCreationMode | null;
  paused: boolean;
  resumeResolve: (() => void) | null;
  abortController: AbortController | null;
  pendingToolRebuild: { toolName: string; tableName: string } | null;
  toolRebuildCount: number;
  terminateCurrentRun: boolean;
}

interface IPersistedSession {
  messages: ModelMessage[];
  lastActivityAt: number;
  jobCreationMode: IJobCreationMode | null;
}

//#endregion Interfaces

//#region MainAgent

export class MainAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: MainAgent | null;
  private _sessions: Map<string, IChatSession>;
  private _currentChatId: string | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    const rawSteps: number = parseInt(process.env.BETTERCLAW_MAIN_AGENT_MAX_STEPS ?? "", 10);

    super({ maxSteps: isNaN(rawSteps) ? DEFAULT_AGENT_MAX_STEPS : rawSteps });
    this._sessions = new Map<string, IChatSession>();
    this._currentChatId = null;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): MainAgent {
    if (!MainAgent._instance) {
      MainAgent._instance = new MainAgent();
    }

    return MainAgent._instance;
  }

  public get currentChatId(): string | null {
    return this._currentChatId;
  }

  public isInitializedForChat(chatId: string): boolean {
    return this._initialized && this._sessions.has(chatId);
  }

  public async initializeForChatAsync(
    chatId: string,
    messageSender: MessageSender,
    photoSender: PhotoSender,
    onStepAsync?: OnStepCallback,
    platform: MessagePlatform = "telegram",
  ): Promise<void> {
    this._currentChatId = chatId;

    // Ensure session exists FIRST — before any async operations that might throw.
    // Create the AbortController immediately so /cancel can abort during initialization
    // (prompt building, tool loading, model setup) before processMessageForChatAsync runs.
    if (!this._sessions.has(chatId)) {
      const saved: IPersistedSession | null = await this._loadSessionAsync(chatId);

      this._sessions.set(chatId, {
        messages: saved?.messages ?? [],
        lastActivityAt: saved?.lastActivityAt ?? Date.now(),
        jobCreationMode: saved?.jobCreationMode ?? null,
        paused: false,
        resumeResolve: null,
        abortController: new AbortController(),
        pendingToolRebuild: null,
        toolRebuildCount: 0,
        terminateCurrentRun: false,
      });

      if (saved !== null) {
        this._logger.info("Session restored from disk.", { chatId, messageCount: saved.messages.length });
      }
    }

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel();
    const contextWindow: number = aiProviderService.getContextWindow();
    this.updateContextWindow(contextWindow);

    const instructions: string = await buildMainAgentPromptAsync();

    const readTracker: FileReadTracker = new FileReadTracker();
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const brainInterface: BrainInterfaceService = BrainInterfaceService.getInstance();
    const promptService: PromptService = PromptService.getInstance();
    const configService: ConfigService = ConfigService.getInstance();
    const config = configService.getConfig();
    const jobCreationGuide: string = await promptService.getPromptAsync(PROMPT_JOB_CREATION_GUIDE);

    const session: IChatSession = this._sessions.get(chatId)!;

    // Per-chat job creation mode tracker — closes over this chat's session object
    const creationModeTracker: IJobCreationModeTracker = {
      setMode: (jobId: string, startNodeId: string): void => {
        session.jobCreationMode = { jobId, startNodeId, auditAttempted: false };
      },
      clearMode: (): void => {
        session.jobCreationMode = null;
      },
      getMode: (): IJobCreationMode | null => session.jobCreationMode,
      markAuditAttempted: (): void => {
        if (session.jobCreationMode) {
          session.jobCreationMode.auditAttempted = true;
        }
      },
    };

    const nodeProgressEmitter: NodeProgressEmitter = async (
      jobId: string,
      activeNodeId: string | undefined,
      nodeStatuses: Record<string, string>,
    ): Promise<void> => {
      await _emitGraphUpdateAsync(chatId, jobId, brainInterface, activeNodeId, nodeStatuses);
    };

    const tools: ToolSet = {
      think: thinkTool,
      run_cmd: runCmdTool,
      run_cmd_input: runCmdInputTool,
      get_cmd_status: getCmdStatusTool,
      get_cmd_output: getCmdOutputTool,
      stop_cmd: stopCmdTool,
      modify_prompt: modifyPromptTool,
      list_prompts: listPromptsTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(messageSender),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
      add_cron: addCronTool,
      remove_cron: removeCronTool,
      list_crons: listCronsTool,
      get_cron: getCronTool,
      edit_cron: editCronTool,
      run_cron: runCronTool,
      fetch_rss: fetchRssTool,
      list_databases: listDatabasesTool,
      list_tables: listTablesTool,
      get_table_schema: getTableSchemaTool,
      create_database: createDatabaseTool,
      create_table: _wrapCreateTableWithHotReload(createTableTool, chatId, session),
      drop_table: dropTableTool,
      read_from_database: readFromDatabaseTool,
      update_database: updateDatabaseTool,
      delete_from_database: deleteFromDatabaseTool,
      searxng: searxngTool,
      crawl4ai: crawl4aiTool,
    };

    // Only include job tools if job creation is enabled
    if (config.jobCreation.enabled) {
      tools.edit_job = editJobTool;
      tools.remove_job = createRemoveJobTool(creationModeTracker);
      tools.get_jobs = getJobsTool;
      tools.run_job = createRunJobTool(jobTracker, nodeProgressEmitter, messageSender);
      tools.render_graph = createRenderGraphTool(photoSender);
      tools.set_job_schedule = setJobScheduleTool;
      tools.remove_job_schedule = removeJobScheduleTool;
    }

    // Only include skill tools if skills are actually loaded
    const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
    if (availableSkills.length > 0) {
      const skillNames = availableSkills.map((s) => s.name);
      tools.call_skill = createCallSkillTool(skillNames);
      tools.get_skill_file = getSkillFileTool;
    }

    if (config.jobCreation.enabled) {
      // start_job_creation is the entry point for mode
      tools.start_job_creation = createStartJobCreationTool(jobTracker, creationModeTracker);
    }

    // Node-creation tools are mode-gated: registered with the agent but only exposed
    // via activeTools when the chat session is in job creation mode.
    // Only register them if job creation is enabled.
    const nodeCreationTools: ToolSet | undefined = config.jobCreation.enabled
      ? {
          add_job: addJobTool,
          finish_job: finishJobTool,
          edit_node: createEditNodeTool(jobTracker),
          remove_node: removeNodeTool,
          connect_nodes: connectNodesTool,
          disconnect_nodes: disconnectNodesTool,
          set_entrypoint: setEntrypointTool,
          add_node_test: addNodeTestTool,
          run_node_test: runNodeTestTool,
          get_nodes: getNodesTool,
          clear_job_graph: clearJobGraphTool,
          add_curl_fetcher_node: createAddCurlFetcherNodeTool(jobTracker),
          add_rss_fetcher_node: createAddRssFetcherNodeTool(jobTracker),
          add_crawl4ai_node: createAddCrawl4aiNodeTool(jobTracker),
          add_searxng_node: createAddSearxngNodeTool(jobTracker),
          add_python_code_node: createAddPythonCodeNodeTool(jobTracker),
          add_output_to_ai_node: createAddOutputToAiNodeTool(jobTracker),
          add_agent_node: createAddAgentNodeTool(jobTracker),
          add_litesql_node: createAddLitesqlNodeTool(jobTracker),
          add_litesql_reader_node: createAddLitesqlReaderNodeTool(jobTracker),
          finish_job_creation: createFinishJobCreationTool(creationModeTracker),
          create_output_schema: createCreateOutputSchemaTool(),
        }
      : undefined;

    // Merge MCP tools from connected servers
    const mcpService: McpService = McpService.getInstance();
    const mcpTools: ToolSet = mcpService.getTools();
    for (const [toolName, toolDef] of Object.entries(mcpTools)) {
      tools[toolName] = toolDef;
    }

    // Merge per-table write tools (generated from database schemas)
    try {
      const perTableTools: ToolSet = await buildPerTableToolsAsync();
      for (const [toolName, toolDef] of Object.entries(perTableTools)) {
        tools[toolName] = toolDef;
      }
    } catch (err: unknown) {
      this._logger.warn("Failed to build per-table tools at startup", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Filter tools based on channel permission
    const channelRegistry = ChannelRegistryService.getInstance();
    const permission = channelRegistry.getPermission(platform, chatId);
    const skillNames = availableSkills.map((s) => s.name);

    const filteredTools: ToolSet = {};
    for (const [toolName, tool] of Object.entries(tools)) {
      if (toolRegistry.isToolAllowed(toolName, permission, { jobCreationEnabled: config.jobCreation.enabled, skillNames })) {
        filteredTools[toolName] = tool;
      }
    }

    // Log registered tools for diagnostics (especially useful for local models)
    this._logger.info("Tools registered for agent", {
      chatId,
      toolCount: Object.keys(filteredTools).length,
      toolNames: Object.keys(filteredTools),
      permission,
      jobCreationEnabled: config.jobCreation.enabled,
    });

    const trackedDoneTool = createDoneTool(jobTracker);

    const combinedOnStepAsync = async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
      this._logger.debug("MainAgent combinedOnStep callback invoked", {
        chatId,
        stepNumber,
        toolCallsCount: toolCalls.length,
        toolNames: toolCalls.map((tc: IToolCallSummary): string => tc.name),
      });

      await brainInterface.emitStepStartedAsync(chatId, stepNumber);

      // Update status to show tool execution progress
      const statusService: StatusService = StatusService.getInstance();
      const toolNames: string = toolCalls.map((tc: IToolCallSummary): string => tc.name).join(", ");
      statusService.setStatus("tool_execution", `Step ${stepNumber}: ${toolNames}`, { chatId, stepNumber, tools: toolNames });

      for (const toolCall of toolCalls) {
        await brainInterface.emitToolCalledAsync(
          chatId,
          stepNumber,
          toolCall.name,
          toolCall.input,
        );

        if (toolCall.result !== undefined || toolCall.isError !== undefined) {
          const isError = toolCall.isError ?? false;
          let errorMsg: string | undefined;

          if (isError) {
            errorMsg = typeof toolCall.result === "string" ? toolCall.result : JSON.stringify(toolCall.result);
          } else if (
             toolCall.result && 
             typeof toolCall.result === "object" && 
             "success" in toolCall.result && 
             (toolCall.result as Record<string, unknown>).success === false
          ) {
             errorMsg = ((toolCall.result as Record<string, unknown>).error as string) ?? "Unknown error";
          }

          await brainInterface.emitToolResultAsync(
            chatId,
            stepNumber,
            toolCall.name,
            toolCall.result,
            errorMsg,
          );
        }

        if (_GraphMutatingTools.has(toolCall.name)) {
          const jobId: string | undefined = toolCall.input.jobId as string | undefined;

          if (jobId) {
            await _emitGraphUpdateAsync(chatId, jobId, brainInterface);
          }
        }
      }

      if (onStepAsync) {
        this._logger.debug("Forwarding onStep callback to platform handler", {
          chatId,
          stepNumber,
          toolCallsCount: toolCalls.length,
        });
        await onStepAsync(stepNumber, toolCalls);
      } else {
        this._logger.debug("No platform onStep callback registered", {
          chatId,
          stepNumber,
        });
      }
    };

    this._buildAgent(
      model,
      instructions,
      filteredTools,
      combinedOnStepAsync,
      trackedDoneTool,
      // getExtraTools: returns node-creation tools when current chat is in creation mode
      nodeCreationTools
        ? (): ToolSet | null => session.jobCreationMode !== null ? nodeCreationTools : null
        : undefined,
      nodeCreationTools,
      // getPausePromise: returns a promise that resolves when the chat is resumed
      (): Promise<void> | null => {
        if (session.paused) {
          return new Promise<void>((resolve: () => void): void => {
            session.resumeResolve = resolve;
          });
        }
        return null;
      },
      // getCreationModePrompt: injects the job creation guide into the system prompt
      // dynamically when the agent is in job creation mode
      (): string | null => session.jobCreationMode !== null ? jobCreationGuide : null,
      // getAbortSignal: provides the current abort signal so prepareStep can check it early
      (): AbortSignal | null => session.abortController?.signal ?? null,
      // shouldTerminateRun: hard-stop the current generate run after successful create_table
      (): boolean => session.terminateCurrentRun,
    );

    this._logger.debug("MainAgent _buildAgent completed", {
      chatId,
      hasOnStepCallback: onStepAsync !== undefined,
    });

    // Register hot-reload callback for per-table tools
    const currentFilteredTools: ToolSet = filteredTools;
    ToolHotReloadService.getInstance().registerRebuildCallback(chatId, (perTableTools: ToolSet) => {
      const mergedTools: ToolSet = { ...currentFilteredTools, ...perTableTools };

      // Re-filter based on permission
      const reFilteredTools: ToolSet = {};
      for (const [toolName, toolDef] of Object.entries(mergedTools)) {
        if (toolRegistry.isToolAllowed(toolName, permission, { jobCreationEnabled: config.jobCreation.enabled, skillNames })) {
          reFilteredTools[toolName] = toolDef;
        }
      }

      this._buildAgent(
        model,
        instructions,
        reFilteredTools,
        combinedOnStepAsync,
        trackedDoneTool,
        nodeCreationTools
          ? (): ToolSet | null => session.jobCreationMode !== null ? nodeCreationTools : null
          : undefined,
        nodeCreationTools,
        (): Promise<void> | null => {
          if (session.paused) {
            return new Promise<void>((resolve: () => void): void => {
              session.resumeResolve = resolve;
            });
          }
          return null;
        },
        (): string | null => session.jobCreationMode !== null ? jobCreationGuide : null,
        (): AbortSignal | null => session.abortController?.signal ?? null,
        (): boolean => session.terminateCurrentRun,
      );

      this._logger.debug("MainAgent _buildAgent completed after hot-reload", {
        chatId,
        hasOnStepCallback: onStepAsync !== undefined,
        toolCount: Object.keys(reFilteredTools).length,
      });

      this._logger.info("Agent tools hot-reloaded", {
        chatId,
        toolCount: Object.keys(reFilteredTools).length,
      });
    });

    this._logger.info("MainAgent initialized for chat.", { chatId, permission });
  }

  public async processMessageForChatAsync(chatId: string, userMessage: string): Promise<IAgentResult> {
    this._ensureInitialized();

    const session: IChatSession | undefined = this._sessions.get(chatId);

    if (!session) {
      this._logger.error("Session not found for chatId — agent not initialized for this chat.", { chatId });
      return { text: "Session not initialized. Please start a new conversation.", stepsCount: 0 };
    }

    session.lastActivityAt = Date.now();
    session.pendingToolRebuild = null;
    session.toolRebuildCount = 0;
    session.terminateCurrentRun = false;

    this._logger.debug("Processing user message", { chatId, messageLength: userMessage.length });

    // Mutable user message — gets replaced with injected message on restart
    let currentUserMessage: string = userMessage;
    let finalResult: IAgentResult = { text: "Unexpected error.", stepsCount: 0 };

    // Outer loop: restarts generate() when a tool rebuild occurs (e.g., create_table)
    while (true) {
      // Append the user message to session history
      const userModelMessage: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: currentUserMessage }],
      };

      // Reuse the AbortController from initializeForChatAsync (created during session
      // setup so /cancel works during initialization). If one doesn't exist, create it.
      let abortController: AbortController = session.abortController ?? new AbortController();
      session.abortController = abortController;

      let result: IAgentResult = { text: "Unexpected error.", stepsCount: 0 };

      const statusService: StatusService = StatusService.getInstance();

      try {
        // Set status to show AI is thinking (in-flight)
        statusService.beginInFlight("llm_request", "Thinking...", { chatId });

        let contextRetries: number = 0;
        let _429Retries: number = 0;

        for (let attempt: number = 1; attempt <= AGENT_EMPTY_RESPONSE_RETRIES + 1; attempt++) {
          // Reset token count so prepareStep doesn't use stale values from a failed attempt
          this._totalInputTokens = 0;

          // Create messagesForCall inside the loop so retries use updated session messages
          const messagesForCall: ModelMessage[] = [...session.messages, userModelMessage];

          try {
            const generateResult = await this._agent!.generate({
              messages: messagesForCall,
              abortSignal: abortController.signal,
            });

            const stepsCount: number = generateResult.steps?.length ?? 1;

            const inputTokens = generateResult.totalUsage?.inputTokens ?? generateResult.usage?.inputTokens;
            if (inputTokens !== undefined) {
              this._totalInputTokens = inputTokens;
            } else {
              this._totalInputTokens = 0;
              this._logger.warn("Token usage missing from LLM response; using tiktoken fallback.");
            }

            const brainInterfaceForOutput: BrainInterfaceService = BrainInterfaceService.getInstance();

            if (generateResult.text) {
              try {
                await brainInterfaceForOutput.emitModelOutputAsync(chatId, stepsCount, generateResult.text);
              } catch {
                // Never let emit failures affect agent execution
              }
            }

            this._logger.debug("Agent response generated", { chatId, stepsCount, historyLength: session.messages.length });

            let text: string = generateResult.text ?? "";

            if (!text && generateResult.steps) {
              interface IToolCallLike { toolName: string; input: Record<string, unknown>; }
              interface IStepLike { toolCalls?: IToolCallLike[]; }

              const doneCall: IToolCallLike | undefined = (generateResult.steps as IStepLike[])
                .flatMap((s: IStepLike): IToolCallLike[] => s.toolCalls ?? [])
                .find((tc: IToolCallLike): boolean => tc.toolName === "done");

              if (doneCall && typeof doneCall.input?.summary === "string") {
                text = doneCall.input.summary;
              }
            }

            // If create_table requested a tool rebuild, end this run immediately and restart.
            // Do not treat missing text as an empty-response failure in this case.
            if (session.pendingToolRebuild !== null) {
              session.messages.push(userModelMessage);

              if (generateResult.response?.messages) {
                for (const responseMsg of generateResult.response.messages) {
                  session.messages.push(responseMsg as ModelMessage);
                }
              }

              this._logger.info("Tool rebuild requested, terminating current run and restarting", {
                chatId,
                stepCount: stepsCount,
                hasText: text.trim().length > 0,
              });

              if (!text.trim()) {
                text = "Table created. Continuing with the newly available write_table tool.";
              }

              result = { text, stepsCount };
              await this._saveSessionAsync(chatId);
              break;
            }

            // If we got text, persist conversation and return
            if (text.trim()) {
              session.messages.push(userModelMessage);

              if (generateResult.response?.messages) {
                for (const responseMsg of generateResult.response.messages) {
                  session.messages.push(responseMsg as ModelMessage);
                }
              }

              result = { text, stepsCount };
              break;
            }

            // Empty response — retry if we have attempts left
            if (attempt <= AGENT_EMPTY_RESPONSE_RETRIES) {
              this._logger.warn("Model returned empty response for chat, retrying", {
                chatId,
                attempt,
                maxRetries: AGENT_EMPTY_RESPONSE_RETRIES,
              });
              continue;
            }

            // All retries exhausted — persist conversation even on failure so history stays consistent
            session.messages.push(userModelMessage);

            if (generateResult.response?.messages) {
              for (const responseMsg of generateResult.response.messages) {
                session.messages.push(responseMsg as ModelMessage);
              }
            }

            this._logger.error("Model returned empty response after all retries", { chatId, attempts: attempt });
            result = {
              text: "I was unable to complete your request — the model returned empty responses after multiple retries. Please try again.",
              stepsCount,
            };
          } catch (genError: unknown) {
            const aiErrorDetails = extractAiErrorDetails(genError);
            const isRetriable429: boolean = aiErrorDetails.statusCode === 429 && _429Retries < MAX_429_RETRIES;

            // Handle context size exceeded errors (from hard gate or real API errors)
            // Covers: 400 (hard gate), 500 (provider), 413/422 (other providers)
            if (
              isContextExceededApiError(genError) &&
              contextRetries < CONTEXT_EXCEEDED_RETRIES
            ) {
              contextRetries++;
              this._logger.warn("Context size exceeded, forcing compaction on next step", {
                chatId,
                contextRetry: contextRetries,
                maxContextRetries: CONTEXT_EXCEEDED_RETRIES,
                statusCode: aiErrorDetails.statusCode,
              });
              this._forceCompactionOnNextStep = true;
              attempt--; // Don't count this against the empty-response retry limit
              continue;
            }

            // Handle 429 rate limit errors with Retry-After wait
            if (isRetriable429) {
              _429Retries++;
              await apply429BackoffAsync({
                logger: this._logger,
                error: genError,
                retryAttempt: _429Retries,
                logMessage: "Rate limited (429) in main agent loop, waiting before retry",
                logContext: {
                  chatId,
                  attempt,
                  emptyResponseAttempt: attempt,
                  _429Retries,
                  current429RetryCount: _429Retries,
                  max429Retries: MAX_429_RETRIES,
                },
              });
              attempt--; // Don't burn the empty-response retry budget
              continue;
            }

            // Re-throw non-context errors
            throw genError;
          }
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          session.abortController = null;
          return { text: "Operation was stopped.", stepsCount: 0 };
        }
        throw error;
      } finally {
        statusService.endInFlight();
        session.abortController = null;
        session.paused = false;
        session.resumeResolve = null;
      }

      // Check if a tool rebuild occurred during this generate() call
      if (
        session.pendingToolRebuild !== null &&
        session.toolRebuildCount < MAX_TOOL_REBUILD_RESTARTS
      ) {
        const rebuildInfo = session.pendingToolRebuild as { toolName: string; tableName: string };
        session.toolRebuildCount++;
        session.pendingToolRebuild = null;
        session.terminateCurrentRun = false;

        this._logger.info("Tool rebuild detected, restarting generate with new tools", {
          chatId,
          toolName: rebuildInfo.toolName,
          tableName: rebuildInfo.tableName,
          restartCount: session.toolRebuildCount,
        });

        // Inject synthetic user message about the new tool
        currentUserMessage = `[System] A new tool "${rebuildInfo.toolName}" for the "${rebuildInfo.tableName}" table is now available. Use it to insert data into that table.`;

        continue; // Restart generate() with fresh agent that has the new tool
      }

      const pendingRebuildInfo = session.pendingToolRebuild;
      if (session.toolRebuildCount >= MAX_TOOL_REBUILD_RESTARTS && pendingRebuildInfo) {
        const pendingToolName: string = (pendingRebuildInfo as { toolName: string; tableName: string }).toolName;
        this._logger.warn("Tool rebuild restart budget exhausted", {
          chatId,
          maxRestarts: MAX_TOOL_REBUILD_RESTARTS,
          pendingTool: pendingToolName,
        });
        session.pendingToolRebuild = null;
        session.terminateCurrentRun = false;
      }

      // No rebuild needed — return result
      finalResult = result;
      await this._saveSessionAsync(chatId);
      break;
    }

    return finalResult;
  }

  public pauseChat(chatId: string): boolean {
    const session: IChatSession | undefined = this._sessions.get(chatId);

    if (!session || session.paused) {
      return false;
    }

    session.paused = true;
    this._logger.info("Chat paused.", { chatId });
    return true;
  }

  public resumeChat(chatId: string): boolean {
    const session: IChatSession | undefined = this._sessions.get(chatId);

    if (!session || !session.paused) {
      return false;
    }

    session.paused = false;

    if (session.resumeResolve) {
      session.resumeResolve();
      session.resumeResolve = null;
    }

    this._logger.info("Chat resumed.", { chatId });
    return true;
  }

  public stopChat(chatId: string): boolean {
    const session: IChatSession | undefined = this._sessions.get(chatId);

    if (!session || !session.abortController) {
      return false;
    }

    session.abortController.abort();
    this._logger.info("Chat stopped.", { chatId });
    return true;
  }

  public clearChatHistory(chatId: string): void {
    this._sessions.delete(chatId);
    ToolHotReloadService.getInstance().unregisterRebuildCallback(chatId);
    fs.unlink(getSessionFilePath(chatId)).catch(() => {
      // File may not exist, ignore
    });
    this._logger.info("Chat history cleared.", { chatId });
  }

  public clearAllChatHistory(): void {
    this._sessions.clear();
    this._logger.info("All chat history cleared.");
  }

  //#endregion Public methods

  //#region Private methods

  private async _saveSessionAsync(chatId: string): Promise<void> {
    const session: IChatSession | undefined = this._sessions.get(chatId);

    if (!session) {
      return;
    }

    const persistable: IPersistedSession = {
      messages: session.messages,
      lastActivityAt: session.lastActivityAt,
      jobCreationMode: session.jobCreationMode,
    };

    try {
      const filePath: string = getSessionFilePath(chatId);
      await fs.writeFile(filePath, JSON.stringify(persistable, null, 2), "utf-8");
      this._logger.debug("Session saved to disk.", { chatId, messageCount: persistable.messages.length });
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      this._logger.warn("Failed to save session to disk, continuing without persistence.", { chatId, error: message });
    }
  }

  private async _loadSessionAsync(chatId: string): Promise<IPersistedSession | null> {
    const filePath: string = getSessionFilePath(chatId);

    try {
      const content: string = await fs.readFile(filePath, "utf-8");
      const parsed: IPersistedSession = JSON.parse(content);

      if (!Array.isArray(parsed.messages)) {
        this._logger.warn("Session file has invalid messages array, ignoring.", { chatId });
        return null;
      }

      return parsed;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      const message: string = error instanceof Error ? error.message : String(error);
      this._logger.warn("Failed to load session from disk, starting fresh.", { chatId, error: message });
      return null;
    }
  }

  //#endregion Private methods
}

//#endregion MainAgent

export type { IAgentResult };

//#region Private functions

async function _emitGraphUpdateAsync(
  chatId: string,
  jobId: string,
  brainInterface: BrainInterfaceService,
  activeNodeId?: string,
  nodeStatuses?: Record<string, string>,
): Promise<void> {
  try {
    const storage: JobStorageService = JobStorageService.getInstance();
    const job: IJob | null = await storage.getJobAsync(jobId);

    if (!job) {
      return;
    }

    const nodes: INode[] = await storage.listNodesAsync(jobId);

    await brainInterface.emitGraphUpdatedAsync(chatId, {
      chatId,
      jobId: job.jobId,
      jobName: job.name,
      nodes,
      entrypointNodeId: job.entrypointNodeId,
      activeNodeId,
      nodeStatuses,
    });
  } catch {
    // Never let graph emit failures affect agent execution
  }
}

function _wrapCreateTableWithHotReload(
  originalTool: ToolSet[string],
  chatId: string,
  session: IChatSession,
): ToolSet[string] {
  const originalExecute = originalTool.execute;

  if (!originalExecute) {
    return originalTool;
  }

  return {
    ...originalTool,
    execute: async (input: unknown, options: any): Promise<unknown> => {
      const result: any = await originalExecute(input, options);

      if (result?.success === true) {
        // Extract table name from input
        const tableName: string = typeof input === "object" && input !== null
          ? String((input as Record<string, unknown>).tableName ?? (input as Record<string, unknown>).name ?? "unknown")
          : "unknown";

        const toolName = `write_table_${tableName}`;

        try {
          const hotReload = ToolHotReloadService.getInstance();
          const rebuildSucceeded: boolean = await hotReload.triggerRebuildAsync(chatId);

          if (!rebuildSucceeded) {
            LoggerService.getInstance().warn("create_table succeeded but tool hot-reload did not complete", {
              chatId,
              toolName,
              tableName,
            });
            return result;
          }

          // Signal that generate() should terminate now and restart with fresh tools
          session.terminateCurrentRun = true;
          session.pendingToolRebuild = { toolName, tableName };

          LoggerService.getInstance().info("create_table triggered hard-stop + tool rebuild", {
            chatId,
            toolName,
            tableName,
          });
        } catch (err: unknown) {
          LoggerService.getInstance().warn("Tool hot-reload failed after create_table", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return result;
    },
  } as ToolSet[string];
}

//#endregion Private functions
