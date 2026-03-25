import fs from "node:fs/promises";
import { ToolSet, LanguageModel, type ModelMessage, type Tool } from "ai";

import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { LoggerService } from "../services/logger.service.js";
import { buildMainAgentPromptAsync } from "./system-prompt.js";
import { BaseAgentBase, AGENT_EMPTY_RESPONSE_RETRIES, CONTEXT_EXCEEDED_RETRIES, type IAgentResult, type OnStepCallback } from "./base-agent.js";
import { McpService } from "../services/mcp.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import {
  thinkTool,
  runCmdTool,
  runCmdInputTool,
  getCmdStatusTool,
  getCmdOutputTool,
  waitForCmdTool,
  stopCmdTool,
  modifyPromptTool,
  listPromptsTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
  type MessageSender,
  createCallSkillTool,
  getSkillFileTool,
  addCronTool,
  removeCronTool,
  listCronsTool,
  getCronTool,
  editCronTool,
  editCronInstructionsTool,
  runCronTool,
  createReadFileTool,
  createReadImageTool,
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
  FileReadTracker,
  searxngTool,
  crawl4aiTool,
} from "../tools/index.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { ToolHotReloadService } from "../services/tool-hot-reload.service.js";
import {
  getConnectionRetryDelayMs,
  isConnectionError,
  isContextExceededApiError,
  isRetryableApiError,
} from "../utils/context-error.js";
import { ensureDirectoryExistsAsync, getSessionsDir, getSessionFilePath } from "../utils/paths.js";
import { apply429BackoffAsync } from "../utils/rate-limit-retry.js";
import { extractAiErrorDetails } from "../utils/ai-error.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import { compactMessagesSummaryOnlyAsync } from "../utils/summarization-compaction.js";
import { countTokens } from "../utils/token-tracker.js";
import { ChannelRegistryService } from "../services/channel-registry.service.js";
import * as toolRegistry from "../helpers/tool-registry.js";
import type { IToolCallSummary } from "./base-agent.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";

//#region Constants

/** Max times generate() can be restarted due to tool rebuild (create_table). */
const MAX_TOOL_REBUILD_RESTARTS: number = 2;
const MAX_429_RETRIES: number = 8;
const MAX_GENERIC_RETRIES: number = 3;
const SESSION_COMPACTION_HEADROOM_TOKENS: number = 4000;

//#endregion Constants

//#region Types

/** Function to send a photo to a chat. Originally used for job graph rendering, now kept for compatibility. */
export type PhotoSender = (imageBuffer: Buffer, caption: string | null) => Promise<string | null>;

//#endregion Types

//#region Interfaces

interface IChatSession {
  messages: ModelMessage[];
  lastActivityAt: number;
  messageSender: MessageSender;
  photoSender: PhotoSender;
  onStepAsync?: OnStepCallback;
  platform: MessagePlatform;
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
}

export interface IChatImageAttachment {
  imageBuffer: Buffer;
  mediaType: string;
}

export interface IRefreshSessionsResult {
  refreshedCount: number;
  failedCount: number;
  failedChatIds: string[];
}

interface IBufferMarker {
  __type: "Buffer";
  __data: string;
}

const _BufferMarkerType: IBufferMarker["__type"] = "Buffer";

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
    const rawSteps: number = parseInt(
      process.env.BLACKDOGBOT_MAIN_AGENT_MAX_STEPS ?? process.env.BETTERCLAW_MAIN_AGENT_MAX_STEPS ?? "",
      10,
    );

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
        messageSender,
        photoSender,
        onStepAsync,
        platform,
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

    const session: IChatSession = this._sessions.get(chatId)!;
    session.messageSender = messageSender;
    session.photoSender = photoSender;
    session.onStepAsync = onStepAsync;
    session.platform = platform;

    const tools: Record<string, unknown> = {
      think: thinkTool as unknown as Tool,
      run_cmd: runCmdTool as unknown as Tool,
      run_cmd_input: runCmdInputTool as unknown as Tool,
      get_cmd_status: getCmdStatusTool as unknown as Tool,
      get_cmd_output: getCmdOutputTool as unknown as Tool,
      wait_for_cmd: waitForCmdTool as unknown as Tool,
      stop_cmd: stopCmdTool as unknown as Tool,
      modify_prompt: modifyPromptTool as unknown as Tool,
      list_prompts: listPromptsTool as unknown as Tool,
      search_knowledge: searchKnowledgeTool as unknown as Tool,
      add_knowledge: addKnowledgeTool as unknown as Tool,
      edit_knowledge: editKnowledgeTool as unknown as Tool,
      send_message: createSendMessageTool(messageSender) as unknown as Tool,
      read_file: createReadFileTool(readTracker) as unknown as Tool,
      write_file: createWriteFileTool(readTracker) as unknown as Tool,
      append_file: appendFileTool as unknown as Tool,
      edit_file: editFileTool as unknown as Tool,
      add_cron: addCronTool as unknown as Tool,
      remove_cron: removeCronTool as unknown as Tool,
      list_crons: listCronsTool as unknown as Tool,
      get_cron: getCronTool as unknown as Tool,
      edit_cron: editCronTool as unknown as Tool,
      edit_cron_instructions: editCronInstructionsTool as unknown as Tool,
      run_cron: runCronTool as unknown as Tool,
      fetch_rss: fetchRssTool as unknown as Tool,
      list_databases: listDatabasesTool as unknown as Tool,
      list_tables: listTablesTool as unknown as Tool,
      get_table_schema: getTableSchemaTool as unknown as Tool,
      create_database: createDatabaseTool as unknown as Tool,
      create_table: _wrapCreateTableWithHotReload(createTableTool as unknown as Tool, chatId, session),
      drop_table: dropTableTool as unknown as Tool,
      read_from_database: readFromDatabaseTool as unknown as Tool,
      update_database: updateDatabaseTool as unknown as Tool,
      delete_from_database: deleteFromDatabaseTool as unknown as Tool,
      searxng: searxngTool as unknown as Tool,
      crawl4ai: crawl4aiTool as unknown as Tool,
    };

    if (aiProviderService.getSupportsVision()) {
      tools.read_image = createReadImageTool(readTracker);
    }

    // Only include skill tools if skills are actually loaded
    const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
    if (availableSkills.length > 0) {
      const skillNames = availableSkills.map((s) => s.name);
      tools.call_skill = createCallSkillTool(skillNames);
      tools.get_skill_file = getSkillFileTool;
    }

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
      if (toolRegistry.isToolAllowed(toolName, permission, { skillNames })) {
        filteredTools[toolName] = tool as unknown as Tool;
      }
    }

    // Log registered tools for diagnostics (especially useful for local models)
    this._logger.info("Tools registered for agent", {
      chatId,
      toolCount: Object.keys(filteredTools).length,
      toolNames: Object.keys(filteredTools),
      permission,
    });

    const combinedOnStepAsync = async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
      this._logger.debug("MainAgent combinedOnStep callback invoked", {
        chatId,
        stepNumber,
        toolCallsCount: toolCalls.length,
        toolNames: toolCalls.map((tc: IToolCallSummary): string => tc.name),
      });

      // Update status to show tool execution progress
      const statusService: StatusService = StatusService.getInstance();
      const toolNames: string = toolCalls.map((tc: IToolCallSummary): string => tc.name).join(", ");
      statusService.setStatus("tool_execution", `Step ${stepNumber}: ${toolNames}`, { chatId, stepNumber, tools: toolNames });

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
      undefined, // was getExtraTools
      undefined, // reserved for extra tools
      // getPausePromise: returns a promise that resolves when the chat is resumed
      (): Promise<void> | null => {
        if (session.paused) {
          return new Promise<void>((resolve: () => void): void => {
            session.resumeResolve = resolve;
          });
        }
        return null;
      },
      undefined, // was getCreationModePrompt
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
        if (toolRegistry.isToolAllowed(toolName, permission, { skillNames })) {
          reFilteredTools[toolName] = toolDef;
        }
      }

      this._buildAgent(
        model,
        instructions,
        reFilteredTools,
        combinedOnStepAsync,
        undefined, // was getExtraTools
        undefined, // was extraTools
        (): Promise<void> | null => {
          if (session.paused) {
            return new Promise<void>((resolve: () => void): void => {
              session.resumeResolve = resolve;
            });
          }
          return null;
        },
        undefined, // was getCreationModePrompt
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

  public async refreshAllSessionsAsync(): Promise<IRefreshSessionsResult> {
    const chatIds: string[] = Array.from(this._sessions.keys());
    let refreshedCount: number = 0;
    const failedChatIds: string[] = [];

    for (const chatId of chatIds) {
      const session: IChatSession | undefined = this._sessions.get(chatId);
      if (!session) {
        continue;
      }

      try {
        await this.initializeForChatAsync(
          chatId,
          session.messageSender,
          session.photoSender,
          session.onStepAsync,
          session.platform,
        );
        refreshedCount++;
      } catch (error: unknown) {
        failedChatIds.push(chatId);
        this._logger.error("Failed to refresh chat session after prompt update", {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result: IRefreshSessionsResult = {
      refreshedCount,
      failedCount: failedChatIds.length,
      failedChatIds,
    };

    this._logger.info("MainAgent sessions refreshed", {
      refreshedCount: result.refreshedCount,
      failedCount: result.failedCount,
      failedChatIds: result.failedChatIds,
    });
    return result;
  }

  public async processMessageForChatAsync(
    chatId: string,
    userMessage: string,
    imageAttachments?: IChatImageAttachment[],
  ): Promise<IAgentResult> {
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
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    try {
      const resetPerformed: boolean = await aiProviderService.resetToPrimaryProviderAsync();
      if (resetPerformed) {
        await this.initializeForChatAsync(
          chatId,
          session.messageSender,
          session.photoSender,
          session.onStepAsync,
          session.platform,
        );
      }
    } catch (error: unknown) {
      this._logger.warn("Failed to reset runtime provider to primary before processing chat", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let currentUserMessage: string = userMessage;
    let finalResult: IAgentResult = { text: "Unexpected error.", stepsCount: 0 };
    let compactionModel: LanguageModel = aiProviderService.getModel();

    // Outer loop: restarts generate() when a tool rebuild occurs (e.g., create_table)
    while (true) {
      // Append the user message to session history
      const resolvedImageAttachments: IChatImageAttachment[] = imageAttachments ?? [];
      const userContent: Array<
        { type: "text"; text: string } |
        { type: "image"; image: Buffer; mediaType?: string }
      > = [];

      if (currentUserMessage.trim().length > 0 || resolvedImageAttachments.length === 0) {
        userContent.push({ type: "text", text: currentUserMessage });
      }

      for (const imageAttachment of resolvedImageAttachments) {
        userContent.push({
          type: "image",
          image: imageAttachment.imageBuffer,
          mediaType: imageAttachment.mediaType,
        });
      }

      const userModelMessage: ModelMessage = {
        role: "user",
        content: userContent,
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
        let _genericRetries: number = 0;

        for (let attempt: number = 1; attempt <= AGENT_EMPTY_RESPONSE_RETRIES + 1; attempt++) {
          // Reset token count so prepareStep doesn't use stale values from a failed attempt
          this._totalInputTokens = 0;
          this._lastPrepareStepEstimatedTokens = null;

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

            this._logger.debug("Agent response generated", { chatId, stepsCount, historyLength: session.messages.length });

            let text: string = generateResult.text ?? "";

            // If create_table requested a tool rebuild, end this run immediately and restart.
            // Do not treat missing text as an empty-response failure in this case.
            if (session.pendingToolRebuild !== null) {
              _appendResponseToSession(session.messages, userModelMessage, generateResult.response?.messages);

              session.messages = await _compactSessionMessagesAsync(
                session.messages,
                compactionModel,
                this._logger,
                this._compactionTokenThreshold,
              );

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
              _appendResponseToSession(session.messages, userModelMessage, generateResult.response?.messages);

              session.messages = await _compactSessionMessagesAsync(
                session.messages,
                compactionModel,
                this._logger,
                this._compactionTokenThreshold,
              );

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
            const fallbackFromEmpty: boolean = await this._activateFallbackAndReinitializeAsync(
              chatId,
              session,
              "empty_response_exhausted",
            );

            if (fallbackFromEmpty) {
              compactionModel = aiProviderService.getModel();
              attempt--; // Retry current request on fallback model
              continue;
            }

            _appendResponseToSession(session.messages, userModelMessage, generateResult.response?.messages);

            session.messages = await _compactSessionMessagesAsync(
              session.messages,
              compactionModel,
              this._logger,
              this._compactionTokenThreshold,
            );

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
              const beforeSessionCompactionTokens: number = countTokens(session.messages);
              session.messages = await _compactSessionMessagesAsync(
                session.messages,
                compactionModel,
                this._logger,
                this._compactionTokenThreshold,
              );
              const afterSessionCompactionTokens: number = countTokens(session.messages);

              this._logger.warn("Context size exceeded, forcing compaction on next step", {
                chatId,
                contextRetry: contextRetries,
                maxContextRetries: CONTEXT_EXCEEDED_RETRIES,
                statusCode: aiErrorDetails.statusCode,
                sessionCompactionBeforeTokens: beforeSessionCompactionTokens,
                sessionCompactionAfterTokens: afterSessionCompactionTokens,
                sessionCompactionReducedBy: beforeSessionCompactionTokens - afterSessionCompactionTokens,
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

            if (isRetryableApiError(genError) && _genericRetries < MAX_GENERIC_RETRIES) {
              _genericRetries++;
              const isConnectionRelatedError: boolean = isConnectionError(genError);
              const retryDelayMs: number = isConnectionRelatedError
                ? getConnectionRetryDelayMs(_genericRetries)
                : 0;

              this._logger.warn("Retryable API error in main agent loop, waiting before retry", {
                chatId,
                attempt,
                emptyResponseAttempt: attempt,
                genericRetryCount: _genericRetries,
                maxGenericRetries: MAX_GENERIC_RETRIES,
                retryType: isConnectionRelatedError ? "connection" : "generic",
                retryDelayMs,
                statusCode: aiErrorDetails.statusCode,
                provider: aiErrorDetails.provider,
                model: aiErrorDetails.model,
                message: aiErrorDetails.message,
                providerMessage: aiErrorDetails.providerMessage,
              });

              if (retryDelayMs > 0) {
                await new Promise<void>((resolve: () => void): void => {
                  setTimeout(resolve, retryDelayMs);
                });
              }

              attempt--; // Don't burn the empty-response retry budget
              continue;
            }

            const fallbackActivated: boolean = await this._activateFallbackAndReinitializeAsync(
              chatId,
              session,
              "error_after_retries",
              genError,
            );

            if (fallbackActivated) {
              compactionModel = aiProviderService.getModel();
              attempt--; // Retry current request on fallback model
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

  public async compactSessionMessagesForChatAsync(chatId: string): Promise<boolean> {
    const session: IChatSession | undefined = this._sessions.get(chatId);
    if (!session) {
      return false;
    }

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const compactionModel: LanguageModel = aiProviderService.getModel();
    const previousLength: number = session.messages.length;
    const previousTokens: number = countTokens(session.messages);

    session.messages = await _compactSessionMessagesAsync(
      session.messages,
      compactionModel,
      this._logger,
      this._compactionTokenThreshold,
    );

    const nextTokens: number = countTokens(session.messages);

    this._logger.info("Manual session compaction executed for chat", {
      chatId,
      previousMessageCount: previousLength,
      nextMessageCount: session.messages.length,
      previousTokens,
      nextTokens,
      reducedBy: previousTokens - nextTokens,
    });

    await this._saveSessionAsync(chatId);
    return true;
  }

  private async _activateFallbackAndReinitializeAsync(
    chatId: string,
    session: IChatSession,
    reason: string,
    error?: unknown,
  ): Promise<boolean> {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const fallback = await aiProviderService.activateNextFallbackProviderAsync();

    if (!fallback) {
      return false;
    }

    this._logger.warn("Activated fallback provider for chat request", {
      chatId,
      reason,
      fallbackProvider: fallback.provider,
      fallbackModel: fallback.model,
      supportsToolCalling: fallback.supportsToolCalling,
      structuredMode: fallback.structuredOutputMode,
      error: error instanceof Error ? error.message : (error ? String(error) : undefined),
    });

    await this.initializeForChatAsync(
      chatId,
      session.messageSender,
      session.photoSender,
      session.onStepAsync,
      session.platform,
    );

    return true;
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
    };

    try {
      await ensureDirectoryExistsAsync(getSessionsDir());
      const filePath: string = getSessionFilePath(chatId);
      await fs.writeFile(filePath, JSON.stringify(persistable, _sessionStringifyReplacer, 2), "utf-8");
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
      const parsed: IPersistedSession = JSON.parse(content, _sessionParseReviver) as IPersistedSession;

      if (!Array.isArray(parsed.messages)) {
        this._logger.warn("Session file has invalid messages array, ignoring.", { chatId });
        return null;
      }

      parsed.messages = _normalizeLoadedSessionMessages(parsed.messages, this._logger, chatId);

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

function _appendResponseToSession(
  sessionMessages: ModelMessage[],
  userMessage: ModelMessage,
  responseMessages?: unknown[],
): void {
  sessionMessages.push(userMessage);

  if (!responseMessages) {
    return;
  }

  for (const responseMsg of responseMessages) {
    sessionMessages.push(responseMsg as ModelMessage);
  }
}

function _sessionStringifyReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return {
      __type: _BufferMarkerType,
      __data: value.toString("base64"),
    } satisfies IBufferMarker;
  }

  if (value instanceof Uint8Array) {
    return {
      __type: _BufferMarkerType,
      __data: Buffer.from(value).toString("base64"),
    } satisfies IBufferMarker;
  }

  return value;
}

function _sessionParseReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__type" in value &&
    (value as { __type?: unknown }).__type === _BufferMarkerType &&
    "__data" in value &&
    typeof (value as { __data?: unknown }).__data === "string"
  ) {
    try {
      return Buffer.from((value as { __data: string }).__data, "base64");
    } catch {
      return value;
    }
  }

  // Backward-compatible restore for Node's default Buffer JSON shape:
  // { type: "Buffer", data: number[] }
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type?: unknown }).type === "Buffer" &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    try {
      return Buffer.from((value as { data: number[] }).data);
    } catch {
      return value;
    }
  }

  return value;
}

function _normalizeLoadedSessionMessages(
  messages: ModelMessage[],
  logger: LoggerService,
  chatId: string,
): ModelMessage[] {
  const normalized: ModelMessage[] = [];

  for (const message of messages) {
    const clonedMessage: ModelMessage = { ...message };

    if (Array.isArray(clonedMessage.content)) {
      const normalizedParts: unknown[] = [];

      for (const part of clonedMessage.content as unknown[]) {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type?: unknown }).type === "image" &&
          "image" in part
        ) {
          const imagePart: Record<string, unknown> = { ...(part as Record<string, unknown>) };
          const imageValue: unknown = imagePart.image;

          if (Buffer.isBuffer(imageValue) || imageValue instanceof Uint8Array || typeof imageValue === "string") {
            normalizedParts.push(imagePart);
            continue;
          }

          if (
            imageValue &&
            typeof imageValue === "object" &&
            "type" in imageValue &&
            (imageValue as { type?: unknown }).type === "Buffer" &&
            "data" in imageValue &&
            Array.isArray((imageValue as { data?: unknown }).data)
          ) {
            try {
              imagePart.image = Buffer.from((imageValue as { data: number[] }).data);
              normalizedParts.push(imagePart);
              continue;
            } catch {
              logger.warn("Dropping invalid legacy image payload from restored session", { chatId });
              continue;
            }
          }

          logger.warn("Dropping invalid image payload from restored session", { chatId });
          continue;
        }

        normalizedParts.push(part);
      }

      clonedMessage.content = normalizedParts as any;
    }

    normalized.push(clonedMessage);
  }

  return normalized;
}

async function _compactSessionMessagesAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  compactionThreshold: number,
): Promise<ModelMessage[]> {
  const targetTokens: number = Math.max(
    1200,
    compactionThreshold - SESSION_COMPACTION_HEADROOM_TOKENS,
  );

  const currentTokens: number = countTokens(messages);
  if (currentTokens <= targetTokens) {
    return messages;
  }

  const compactionResult = await compactMessagesSummaryOnlyAsync(
    messages,
    model,
    logger,
    targetTokens,
    (msgs: ModelMessage[]): number => countTokens(msgs),
  );

  return compactionResult.messages;
}

function _wrapCreateTableWithHotReload(
  originalTool: Tool,
  chatId: string,
  session: IChatSession,
): Tool {
  const originalExecute = (originalTool as Record<string, unknown>).execute as ((input: unknown, options: unknown) => Promise<unknown>) | undefined;

  if (!originalExecute) {
    return originalTool;
  }

  return {
    ...originalTool,
    execute: async (input: unknown, options: unknown): Promise<unknown> => {
      const result: unknown = await originalExecute(input, options);

      if (typeof result === "object" && result !== null && (result as Record<string, unknown>).success === true) {
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
  } as Tool;
}

//#endregion Private functions
