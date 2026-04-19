
import { ToolSet, LanguageModel, type ModelMessage } from "ai";

import { assembleToolsForChat } from "./tool-assembly.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { LoggerService } from "../services/logger.service.js";
import { buildMainAgentPromptAsync } from "./system-prompt.js";
import {
  BaseAgentBase,
  type IAgentResult,
  type OnStepCallback,
  DuplicateToolLoopHardStopError,
  EDuplicateLoopAction,
  type IDuplicateToolCallLoopInfo,
} from "./base-agent.js";
import { McpService } from "../services/mcp.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { FileReadTracker } from "../tools/index.js";
import type { MessageSender } from "../tools/index.js";
import { ToolHotReloadService } from "../services/tool-hot-reload.service.js";
import { BrainInterfaceService } from "../brain-interface/service.js";
import type { IBrainInterfaceEmitter } from "../brain-interface/types.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { ConfigService } from "../services/config.service.js";

import { saveSessionAsync as _saveSessionAsync, loadSessionAsync as _loadSessionAsync, type IPersistedSession } from "./session-manager.js";
import { AdminControl, createAdminControl } from "./admin-control.js";
import { buildPerTableToolsWithUpdatesAsync } from "../utils/per-table-tools.js";
import { compactMessagesSummaryOnlyAsync } from "../utils/summarization-compaction.js";
import { countTokens } from "../utils/token-tracker.js";
import { redactSensitiveData } from "../utils/log-redaction.js";
import * as toolRegistry from "../helpers/tool-registry.js";
import { ChannelRegistryService } from "../services/channel-registry.service.js";
import type { IToolCallSummary } from "./base-agent.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";

import { DuplicateLoopHandler } from "./duplicate-loop-handler.js";
import { RetryOrchestrator } from "./retry-orchestrator.js";

type TGenerateFn = (input: { messages: ModelMessage[]; abortSignal: AbortSignal }) => Promise<{ text: string; steps?: unknown[]; totalUsage?: Record<string, number | undefined>; usage?: Record<string, number | undefined>; response?: { messages?: unknown[] } }>;

//#region Constants

const MAX_TOOL_REBUILD_RESTARTS: number = 2;
const SESSION_COMPACTION_HEADROOM_TOKENS: number = 4000;

//#endregion Constants

//#region Interfaces

interface IDuplicateLoopEscalationState {
  activeSignature: string | null;
  adviserAttemptsRemaining: number;
}

export interface IChatSession {
  messages: ModelMessage[];
  lastActivityAt: number;
  messageSender: MessageSender;
  photoSender: (imageBuffer: Buffer, caption: string | null) => Promise<string | null>;
  onStepAsync?: OnStepCallback;
  platform: MessagePlatform;
  paused: boolean;
  resumeResolve: (() => void) | null;
  abortController: AbortController | null;
  pendingToolRebuild: { toolName: string; tableName: string } | null;
  toolRebuildCount: number;
  terminateCurrentRun: boolean;
  steeringQueue: string[];
  isSteeringAbort: boolean;
  duplicateLoopEscalation: IDuplicateLoopEscalationState;
  currentUserTask: string;
}

//#endregion Interfaces

export interface IChatImageAttachment {
  imageBuffer: Buffer;
  mediaType: string;
}

export interface IRefreshSessionsResult {
  refreshedCount: number;
  failedCount: number;
  failedChatIds: string[];
}


//#region MainAgent
export class MainAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: MainAgent | null;
  private _sessions: Map<string, IChatSession>;
  private _currentChatId: string | null;
  private _adminControl: AdminControl;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    const rawSteps: number = parseInt(
      process.env.BLACKDOGBOT_MAIN_AGENT_MAX_STEPS ?? "",
      10,
    );

    super({ maxSteps: isNaN(rawSteps) ? DEFAULT_AGENT_MAX_STEPS : rawSteps });
    this._sessions = new Map<string, IChatSession>();
    this._currentChatId = null;
    this._adminControl = createAdminControl(this._sessions, this._logger);
  }

  //#endregion Constructors

  //#region Public methods

  /**
   * Returns the singleton instance of MainAgent.
   * @returns The MainAgent singleton instance
   */
  public static getInstance(): MainAgent {
    if (!MainAgent._instance) {
      MainAgent._instance = new MainAgent();
    }

    return MainAgent._instance;
  }

  public get currentChatId(): string | null {
    return this._currentChatId;
  }

  /**
   * Checks if the agent is initialized for a specific chat.
   * @param chatId - The chat identifier to check
   * @returns true if the agent is initialized and has a session for the chatId
   */
  public isInitializedForChat(chatId: string): boolean {
    return this._initialized && this._sessions.has(chatId);
  }

  /**
   * Returns all active chat IDs that have initialized sessions.
   * @returns Array of chat IDs with active sessions
   */
  public getActiveChatIds(): string[] {
    return Array.from(this._sessions.keys());
  }

  /**
   * Initializes the agent for a specific chat session.
   * Creates or restores a session, sets up the AI model, builds the system prompt,
   * assembles available tools, and configures the agent for message processing.
   * @param chatId - Unique identifier for the chat session
   * @param messageSender - Callback function for sending text messages to the user
   * @param photoSender - Callback function for sending photos; returns message ID or null
   * @param onStepAsync - Optional callback invoked after each agent step with tool call summaries
   * @param platform - Messaging platform identifier (default: "telegram")
   * @returns Promise that resolves when initialization is complete
   */
  public async initializeForChatAsync(
    chatId: string,
    messageSender: MessageSender,
    photoSender: (imageBuffer: Buffer, caption: string | null) => Promise<string | null>,
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
        steeringQueue: [],
        isSteeringAbort: false,
        duplicateLoopEscalation: {
          activeSignature: null,
          adviserAttemptsRemaining: DuplicateLoopHandler.MAX_ATTEMPTS,
        },
        currentUserTask: "",
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
    const brainInterface: IBrainInterfaceEmitter = BrainInterfaceService.getInstance();
    ConfigService.getInstance();

    const session: IChatSession = this._sessions.get(chatId)!;
    session.messageSender = messageSender;
    session.photoSender = photoSender;
    session.onStepAsync = onStepAsync;
    session.platform = platform;

    // Assemble tools using the shared factory
    const filteredTools: ToolSet = await assembleToolsForChat(
      chatId,
      messageSender,
      readTracker,
      AiProviderService.getInstance(),
      McpService.getInstance(),
      SkillLoaderService.getInstance(),
      platform,
    );

    // Capture permission and skill names for hot-reload callback scope
    const channelRegistry = ChannelRegistryService.getInstance();
    const permission = channelRegistry.getPermission(platform, chatId);

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

        const loggingConfig = ConfigService.getInstance().getLoggingConfig();
        if (loggingConfig.fullToolArgs) {
          const maxBytes: number = loggingConfig.fullToolArgsMaxBytes ?? 200000;
          const redactedInput: unknown = redactSensitiveData(toolCall.input);
          const redactedOutput: unknown = redactSensitiveData(toolCall.result);
          const serializedPayload: string = JSON.stringify({ input: redactedInput, output: redactedOutput });
          const truncated: boolean = Buffer.byteLength(serializedPayload, "utf-8") > maxBytes;

          LoggerService.getInstance().logStructured("tool", {
            scope: "main",
            chatId,
            stepNumber,
            toolName: toolCall.name,
            isError: toolCall.isError ?? false,
            truncated,
            maxBytes,
            input: truncated ? JSON.stringify(redactedInput).slice(0, maxBytes) : redactedInput,
            output: truncated ? JSON.stringify(redactedOutput).slice(0, maxBytes) : redactedOutput,
          });
        }

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
      undefined,
      undefined,
      (): Promise<void> | null => {
        if (session.paused) {
          return new Promise<void>((resolve: () => void): void => {
            session.resumeResolve = resolve;
          });
        }
        return null;
      },
      (): string | null => null,
      (): AbortSignal | null => session.abortController?.signal ?? null,
      undefined,
      this._createDuplicateToolLoopCallback(chatId),
    );

    this._logger.debug("MainAgent _buildAgent completed", {
      chatId,
      hasOnStepCallback: onStepAsync !== undefined,
    });

    // Register hot-reload callback for per-table tools
    const currentFilteredTools: ToolSet = filteredTools;
    ToolHotReloadService.getInstance().registerRebuildCallback(chatId, async () => {
      const logger: LoggerService = LoggerService.getInstance();
      const { write: writeResult, update: updateResult } = await buildPerTableToolsWithUpdatesAsync();
      if (writeResult.dbStatus === "corrupt" || updateResult.dbStatus === "corrupt") {
        logger.error("Database corrupt - per-table tools unavailable during hot-reload", {
          writeDbStatus: writeResult.dbStatus,
          updateDbStatus: updateResult.dbStatus,
        });
      }
      const perTableTools: ToolSet = { ...writeResult.tools, ...updateResult.tools };
       const mergedTools: ToolSet = { ...currentFilteredTools, ...perTableTools };

       // Re-filter based on permission
       const reFilteredTools: ToolSet = {};
       const hotReloadSkillNames = SkillLoaderService.getInstance().getAvailableSkills()
         .map((s) => s.name);
       for (const [toolName, toolDef] of Object.entries(mergedTools)) {
         if (toolRegistry.isToolAllowed(toolName, permission, { skillNames: hotReloadSkillNames })) {
          reFilteredTools[toolName] = toolDef;
        }
      }

      this._buildAgent(
        model,
        instructions,
        reFilteredTools,
        combinedOnStepAsync,
        undefined,
        undefined,
        (): Promise<void> | null => {
          if (session.paused) {
            return new Promise<void>((resolve: () => void): void => {
              session.resumeResolve = resolve;
            });
          }
          return null;
        },
        (): string | null => null,
        (): AbortSignal | null => session.abortController?.signal ?? null,
        undefined,
        this._createDuplicateToolLoopCallback(chatId),
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

  /**
   * Re-initializes all active chat sessions with current configuration.
   * Useful after prompt updates or tool changes to propagate changes to all sessions.
   * @returns Promise resolving to result object with counts of refreshed and failed sessions
   */
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

  /**
   * Processes a user message and generates an agent response.
   * Handles message history management, token compaction, tool execution,
   * and fallback provider activation on errors.
   * @param chatId - The chat session identifier
   * @param userMessage - The user's input message text
   * @param imageAttachments - Optional array of image attachments with buffer and media type
   * @returns Promise resolving to agent result with response text and step count
   */
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
    session.currentUserTask = userMessage;

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
      this._logger.error("Failed to reset runtime provider to primary before processing chat", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
      let continueAfterSteeringAbort: boolean = false;

      let result: IAgentResult = { text: "Unexpected error.", stepsCount: 0 };

      const statusService: StatusService = StatusService.getInstance();

      try {
        // Delegate generation loop with full retry logic to orchestrator.
        // Returns a result (text, stepCount), whether fallback is needed,
        // and the compaction model. Main-agent handles response appending,
        // session saving, tool rebuild detection, and steering abort logic outside this block.
        const genResult = await this._runGenerationCycleAsync(
          chatId,
          aiProviderService,
          async (input): Promise<any> => {
            const response = await this._agent!.generate({
              messages: input.messages,
              abortSignal: input.abortSignal,
            });

            return {
              text: response.text ?? "",
              steps: response.steps,
              totalUsage: response.totalUsage,
              usage: response.usage,
              response: response.response?.messages ? { messages: response.response.messages } : undefined,
            };
          },
          abortController.signal,
        );

        result = genResult.result;

        // Handle empty response or failed fallback — persist conversation even on failure
        if (genResult.shouldFallback) {
          const fallbackFromEmpty: boolean = await this._activateFallbackAndReinitializeAsync(
            chatId,
            session,
            "empty_response_exhausted",
          );

          // Only update compaction model if fallback was NOT activated (fallback already handles it)
          if (!fallbackFromEmpty) {
            compactionModel = genResult.compactionModel;
          }

          // Append response to session and compact even on failure
          _appendResponseToSession(session.messages, userModelMessage, undefined);

          session.messages = await _compactSessionMessagesAsync(
            session.messages,
            compactionModel,
            this._logger,
            this._compactionTokenThreshold,
            this._contextWindow,
          );

          if (!result.text.trim()) {
            result = { text: "I was unable to complete your request — the model returned empty responses after multiple retries. Please try again.", stepsCount: 0 };
          }

          this._logger.error("Model returned error response after all retries", { chatId });
        }

        // On success with text — append response, compact, and return
        if (result.text.trim() && result !== null) {
          _appendResponseToSession(session.messages, userModelMessage, undefined);

          session.messages = await _compactSessionMessagesAsync(
            session.messages,
            compactionModel,
            this._logger,
            this._compactionTokenThreshold,
            this._contextWindow,
          );
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          session.abortController = null;
          if (session.isSteeringAbort) {
            session.isSteeringAbort = false;
            continueAfterSteeringAbort = true;
          } else {
            return { text: "Operation was stopped.", stepsCount: 0 };
          }
        } else if (error instanceof DuplicateToolLoopHardStopError) {
          this._logger.warn("Duplicate tool loop hard stop triggered", {
            chatId,
            loopInfo: error.loopInfo.summaryString,
          });
          this._resetDuplicateLoopEscalation(chatId);
          return {
            text: "model wasnt able to complete request reason: duplicate tool calls\n\nrecommendation: run /clear",
            stepsCount: 0,
          };
        } else {
          throw error;
        }
      } finally {
        statusService.endInFlight();
        session.abortController = null;
        session.paused = false;
        session.resumeResolve = null;
      }

      if (continueAfterSteeringAbort) {
        this._logger.info("Continuing run after steering abort", { chatId, queuedSteeringMessages: session.steeringQueue.length });
        continue;
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

    this._resetDuplicateLoopEscalation(chatId);
    return finalResult;
  }

  /**
   * Manually compacts the message history for a chat session.
   * Reduces token usage by summarizing older messages while preserving conversation context.
   * @param chatId - The chat session identifier
   * @returns Promise resolving to true if compaction was performed, false if session not found
   */
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
      this._contextWindow,
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

private async _runGenerationCycleAsync(
    chatId: string,
    _aiProviderService: AiProviderService,
    generateFn: TGenerateFn,
    _abortSignal: AbortSignal,
  ): Promise<{ result: IAgentResult; shouldFallback: boolean; compactionModel: LanguageModel }> {
    // Note: status management (beginInFlight/endInFlight) is handled externally in processMessageForChatAsync
    // to avoid double-calling. This method focuses purely on the generate-and-retry loop.

    const orchestrationResult = await RetryOrchestrator.runCycle({
      chatId,
      logger: this._logger,
      model: _aiProviderService.getModel(),
      maxSteps: this._maxSteps,
      compactionThreshold: this._compactionTokenThreshold,
      contextWindow: this._contextWindow,
      generateFn,
      resetTokenCounters: () => {
        this._totalInputTokens = 0;
        this._lastPrepareStepEstimatedTokens = null;
      },
      totalInputTokensSink: (value: number) => {
        this._totalInputTokens = value;
      },
      emitModelOutputAsync: async (_chatId2: string, _stepNumber: number, _text: string) => {
        // TODO: Implement model output emission via BrainInterfaceService when integration is finalized
      },
    });

    const resultCopy: IAgentResult = {
      text: orchestrationResult.result.text,
      stepsCount: orchestrationResult.result.stepsCount,
    };

    // Handle fallback when retries exhausted or non-retryable errors
    if (orchestrationResult.shouldFallback) {
      return { result: resultCopy, shouldFallback: true, compactionModel: _aiProviderService.getModel() };
    }

    return { result: resultCopy, shouldFallback: false, compactionModel: _aiProviderService.getModel() };
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

  /**
   * Pauses an active chat session, halting message processing.
   * @param chatId - The chat session identifier
   * @returns true if the chat was paused, false if not found or already paused
   */
  public pauseChat(chatId: string): boolean {
    return this._adminControl.pauseChat(chatId);
  }

  /**
   * Resumes a paused chat session.
   * @param chatId - The chat session identifier
   * @returns true if the chat was resumed, false if not found or not paused
   */
  public resumeChat(chatId: string): boolean {
    return this._adminControl.resumeChat(chatId);
  }

  /**
   * Stops an active chat session and aborts in-flight operations.
   * @param chatId - The chat session identifier
   * @returns true if the chat was stopped, false if not found or not active
   */
  public stopChat(chatId: string): boolean {
    return this._adminControl.stopChat(chatId);
  }

  /**
   * Injects a steering message into a chat session to guide agent behavior.
   * @param chatId - The chat session identifier
   * @param message - The steering instruction to inject
   * @returns true if the message was queued, false if session not found
   */
  public steerChat(chatId: string, message: string): boolean {
    return this._adminControl.steerChat(chatId, message);
  }

  /**
   * Clears the message history for a specific chat session.
   * @param chatId - The chat session identifier
   */
  public clearChatHistory(chatId: string): void {
    this._adminControl.clearChatHistory(chatId);
  }

  /**
   * Clears message history for all chat sessions.
   */
  public clearAllChatHistory(): void {
    this._adminControl.clearAllChatHistory();
  }

  //#endregion Public methods

  //#region Private methods

  private async _saveSessionAsync(chatId: string): Promise<void> {
    await _saveSessionAsync(this._sessions, chatId);
  }

  private async _loadSessionAsync(chatId: string): Promise<IPersistedSession | null> {
    return _loadSessionAsync<IPersistedSession & IChatSession>(chatId);
  }

  private _createDuplicateToolLoopCallback(
    chatId: string,
  ): (loopInfo: IDuplicateToolCallLoopInfo, stepNumber: number, messages: ModelMessage[]) => Promise<EDuplicateLoopAction> {
    const handler = new DuplicateLoopHandler();

    return async (
      loopInfo: IDuplicateToolCallLoopInfo,
      stepNumber: number,
      messages: ModelMessage[],
    ): Promise<EDuplicateLoopAction> => {
      const session: IChatSession | undefined = this._sessions.get(chatId);

      if (!session) {
        return EDuplicateLoopAction.ForceThink;
      }

      const escalation: IDuplicateLoopEscalationState = session.duplicateLoopEscalation;

      const result = handler.handle(
        chatId,
        loopInfo,
        stepNumber,
        messages,
        escalation,
        session.steeringQueue,
        {
          info: (msg: string): void => this._logger.info(msg),
          warn: (msg: string): void => this._logger.warn(msg),
        },
      );


      return result.action;
    };
  }

  private _resetDuplicateLoopEscalation(_chatId: string): void {
    const session: IChatSession | undefined = this._sessions.get(_chatId);
    if (session) {
      const handler = new DuplicateLoopHandler();
      handler.reset(session.duplicateLoopEscalation);
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

async function _compactSessionMessagesAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
  compactionThreshold: number,
  contextWindow: number,
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
    false,
    {
      contextWindow,
    },
  );

  return compactionResult.messages;
}

//#endregion Private functions
