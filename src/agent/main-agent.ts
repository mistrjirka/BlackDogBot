import { ToolSet, LanguageModel, type ModelMessage } from "ai";

import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { buildMainAgentPromptAsync } from "./system-prompt.js";
import { BaseAgentBase, type IAgentResult, type OnStepCallback } from "./base-agent.js";
import { DEFAULT_AGENT_MAX_STEPS, PROMPT_JOB_CREATION_GUIDE } from "../shared/constants.js";
import {
  thinkTool,
  runCmdTool,
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
  callSkillTool,
  getSkillFileTool,
  addCronTool,
  removeCronTool,
  listCronsTool,
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
  queryDatabaseTool,
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
  setJobScheduleTool,
  removeJobScheduleTool,
} from "../tools/index.js";
import { BrainInterfaceService } from "../brain-interface/service.js";
import { PromptService } from "../services/prompt.service.js";
import { JobStorageService } from "../services/job-storage.service.js";
import type { IJob, INode } from "../shared/types/index.js";
import type { IToolCallSummary } from "./base-agent.js";

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

//#endregion Constants

//#region Interfaces

interface IChatSession {
  messages: ModelMessage[];
  lastActivityAt: number;
  jobCreationMode: IJobCreationMode | null;
  paused: boolean;
  resumeResolve: (() => void) | null;
  abortController: AbortController | null;
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

  public async initializeForChatAsync(
    chatId: string,
    messageSender: MessageSender,
    photoSender: PhotoSender,
    onStepAsync?: OnStepCallback,
  ): Promise<void> {
    this._currentChatId = chatId;
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel();
    const instructions: string = await buildMainAgentPromptAsync();

    const readTracker: FileReadTracker = new FileReadTracker();
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const brainInterface: BrainInterfaceService = BrainInterfaceService.getInstance();
    const promptService: PromptService = PromptService.getInstance();
    const jobCreationGuide: string = await promptService.getPromptAsync(PROMPT_JOB_CREATION_GUIDE);

    // Ensure session exists before building trackers that close over it
    if (!this._sessions.has(chatId)) {
      this._sessions.set(chatId, {
        messages: [],
        lastActivityAt: Date.now(),
        jobCreationMode: null,
        paused: false,
        resumeResolve: null,
        abortController: null,
      });
    }

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
      edit_job: editJobTool,
      remove_job: createRemoveJobTool(creationModeTracker),
      get_jobs: getJobsTool,
      run_job: createRunJobTool(jobTracker, nodeProgressEmitter),
      call_skill: callSkillTool,
      get_skill_file: getSkillFileTool,
      add_cron: addCronTool,
      remove_cron: removeCronTool,
      list_crons: listCronsTool,
      set_job_schedule: setJobScheduleTool,
      remove_job_schedule: removeJobScheduleTool,
      render_graph: createRenderGraphTool(photoSender),
      fetch_rss: fetchRssTool,
      list_databases: listDatabasesTool,
      list_tables: listTablesTool,
      get_table_schema: getTableSchemaTool,
      create_database: createDatabaseTool,
      create_table: createTableTool,
      drop_table: dropTableTool,
      query_database: queryDatabaseTool,
      // start_job_creation is always available (entry point for mode)
      start_job_creation: createStartJobCreationTool(jobTracker, creationModeTracker),
    };

    // Node-creation tools are mode-gated: registered with the agent but only exposed
    // via activeTools when the chat session is in job creation mode.
    const nodeCreationTools: ToolSet = {
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
    };

    const trackedDoneTool = createDoneTool(jobTracker);

    const combinedOnStepAsync = async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
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
        await onStepAsync(stepNumber, toolCalls);
      }
    };

    this._buildAgent(
      model,
      instructions,
      tools,
      combinedOnStepAsync,
      trackedDoneTool,
      // getExtraTools: returns node-creation tools when current chat is in creation mode
      (): ToolSet | null => session.jobCreationMode !== null ? nodeCreationTools : null,
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
    );

    this._logger.info("MainAgent initialized for chat.", { chatId });
  }

  public async processMessageForChatAsync(chatId: string, userMessage: string): Promise<IAgentResult> {
    this._ensureInitialized();

    const session: IChatSession = this._sessions.get(chatId)!;

    session.lastActivityAt = Date.now();

    this._logger.debug("Processing user message", { chatId, messageLength: userMessage.length });

    // Append the user message to session history
    const userModelMessage: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: userMessage }],
    };

    const messagesForCall: ModelMessage[] = [...session.messages, userModelMessage];

    const abortController: AbortController = new AbortController();
    session.abortController = abortController;

    let result: IAgentResult;

    const statusService: StatusService = StatusService.getInstance();

    try {
      // Set status to show AI is thinking (in-flight)
      statusService.beginInFlight("llm_request", "Thinking...", { chatId });

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

      // Persist the conversation: add user message + response messages to session
      session.messages.push(userModelMessage);

      if (generateResult.response?.messages) {
        for (const responseMsg of generateResult.response.messages) {
          session.messages.push(responseMsg as ModelMessage);
        }
      }

      this._logger.debug("Agent response generated", { chatId, stepsCount, historyLength: session.messages.length });

      // If the model produced no text (e.g. was forced to call done at maxSteps without
      // having called send_message), fall back to the done tool's summary so the user
      // always receives a reply.
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

      result = { text, stepsCount };
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

    return result;
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
    this._logger.info("Chat history cleared.", { chatId });
  }

  public clearAllChatHistory(): void {
    this._sessions.clear();
    this._logger.info("All chat history cleared.");
  }

  //#endregion Public methods
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

//#endregion Private functions
