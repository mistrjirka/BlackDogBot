import type { DynamicStructuredTool } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../services/logger.service.js";
import { PromptService } from "../services/prompt.service.js";
import { ConfigService } from "../services/config.service.js";
import { createLangchainAgent, invokeAgentAsync } from "./langchain-agent.js";
import type { IAiConfig } from "../shared/types/config.types.js";
import type { IChatImageAttachment, IAgentResult, IToolCallSummary } from "./types.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";
import type { IRefreshSessionsResult } from "./main-agent.js";

type MessageSender = (message: string) => Promise<string | null>;
type PhotoSender = (imageBuffer: Buffer, caption: string | null) => Promise<string | null>;
type OnStepCallback = (stepNumber: number, toolCalls: IToolCallSummary[]) => Promise<void>;

interface IChatSession {
  chatId: string;
  platform: MessagePlatform;
  messageSender: MessageSender;
  photoSender: PhotoSender;
  onStepAsync?: OnStepCallback;
}

export interface IClearSessionsResult {
  clearedCount: number;
  failedChatIds: string[];
}

export class LangchainMainAgent {
  private static _instance: LangchainMainAgent | null = null;

  private _logger = LoggerService.getInstance();
  private _checkpointer: SqliteSaver | null = null;
  private _sessions: Map<string, IChatSession> = new Map();
  private _abortControllers: Map<string, AbortController> = new Map();
  private _tools: DynamicStructuredTool[] = [];
  private _systemPrompt: string = "";
  private _aiConfig: IAiConfig | null = null;

  public static getInstance(): LangchainMainAgent {
    if (!LangchainMainAgent._instance) {
      LangchainMainAgent._instance = new LangchainMainAgent();
    }
    return LangchainMainAgent._instance;
  }

  private constructor() {}

  public async initializeAsync(tools: DynamicStructuredTool[]): Promise<void> {
    this._tools = tools;
    this._systemPrompt = await PromptService.getInstance().getPromptAsync("main-agent");
    this._aiConfig = ConfigService.getInstance().getConfig().ai;
    this._checkpointer = await this._createCheckpointer();
    this._logger.info("LangchainMainAgent initialized", { toolCount: tools.length });
  }

  private async _createCheckpointer(): Promise<SqliteSaver> {
    const baseDir = path.join(os.homedir(), ".blackdogbot");
    const dbPath = path.join(baseDir, "chat-checkpoints.db");
    return SqliteSaver.fromConnString(dbPath);
  }

  public isInitializedForChat(chatId: string): boolean {
    return this._sessions.has(chatId);
  }

  public get currentChatId(): string | null {
    const sessionIds = Array.from(this._sessions.keys());
    return sessionIds.length > 0 ? sessionIds[sessionIds.length - 1] : null;
  }

  public async initializeForChatAsync(
    chatId: string,
    messageSender: MessageSender,
    photoSender: PhotoSender,
    onStepAsync?: OnStepCallback,
    platform?: MessagePlatform,
  ): Promise<void> {
    const existingSession = this._sessions.get(chatId);
    this._sessions.set(chatId, {
      chatId,
      platform: platform ?? existingSession?.platform ?? "telegram",
      messageSender,
      photoSender,
      onStepAsync,
    });
    this._logger.info("Session initialized", { chatId, platform });
  }

  public async processMessageForChatAsync(
    chatId: string,
    userMessage: string,
    imageAttachments?: IChatImageAttachment[],
  ): Promise<IAgentResult> {
    const session = this._sessions.get(chatId);
    if (!session) {
      throw new Error(`Session not initialized for chat ${chatId}`);
    }

    if (!this._checkpointer || !this._aiConfig) {
      throw new Error("Agent not initialized. Call initializeAsync first.");
    }

    const abortController = new AbortController();
    this._abortControllers.set(chatId, abortController);

    try {
      const agent = createLangchainAgent({
        aiConfig: this._aiConfig,
        systemPrompt: this._systemPrompt,
        tools: this._tools,
        checkpointer: this._checkpointer,
      });

      const result = await invokeAgentAsync(
        agent,
        userMessage,
        chatId,
        imageAttachments,
      );

      return {
        text: result.text,
        stepsCount: result.stepsCount,
      };
    } finally {
      this._abortControllers.delete(chatId);
    }
  }

  public stopChat(chatId: string): boolean {
    const controller = this._abortControllers.get(chatId);
    if (controller) {
      controller.abort();
      this._abortControllers.delete(chatId);
      this._logger.info("Chat stopped", { chatId });
      return true;
    }
    return false;
  }

  public async compactSessionMessagesForChatAsync(chatId: string): Promise<boolean> {
    const session = this._sessions.get(chatId);
    if (!session) {
      return false;
    }

    this._logger.info("Compaction requested for chat", { chatId });
    this._logger.info("Note: LangGraph handles context automatically - manual compaction not implemented");
    return true;
  }

  public clearChatHistory(chatId: string): void {
    this._sessions.delete(chatId);
    this._abortControllers.delete(chatId);
    this._logger.info("Chat history cleared", { chatId });
  }

  public clearAllChatHistory(): void {
    const count = this._sessions.size;
    this._sessions.clear();
    this._abortControllers.clear();
    this._logger.info("All chat history cleared", { count });
  }

  public async refreshAllSessionsAsync(): Promise<IRefreshSessionsResult> {
    this._systemPrompt = await PromptService.getInstance().getPromptAsync("main-agent");

    const refreshedCount = this._sessions.size;
    const failedChatIds: string[] = [];

    this._logger.info("All sessions refreshed", { refreshedCount });

    return {
      refreshedCount,
      failedCount: failedChatIds.length,
      failedChatIds,
    };
  }
}