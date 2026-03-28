import type { DynamicStructuredTool } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { LoggerService } from "../services/logger.service.js";
import { PromptService } from "../services/prompt.service.js";
import { ConfigService } from "../services/config.service.js";
import { AiCapabilityService } from "../services/ai-capability.service.js";
import { ChannelRegistryService } from "../services/channel-registry.service.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { LangchainMcpService } from "../services/langchain-mcp.service.js";
import { ToolHotReloadService } from "../services/tool-hot-reload.service.js";
import { createLangchainAgent, invokeAgentAsync } from "./langchain-agent.js";
import { isContextExceededApiError } from "../utils/context-error.js";
import type { IAiConfig } from "../shared/types/config.types.js";
import type { IChatImageAttachment, IAgentResult, IToolCallSummary } from "./types.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";
import type { ChannelPermission } from "../shared/types/channel.types.js";
import type { IRefreshSessionsResult } from "./types.js";
import * as toolRegistry from "../helpers/tool-registry.js";
import {
  thinkTool,
  thinkTracker,
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
  searxngTool,
  crawl4aiTool,
  FileReadTracker,
} from "../tools/index.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";

type MessageSender = (message: string) => Promise<string | null>;
type PhotoSender = (imageBuffer: Buffer, caption: string | null) => Promise<string | null>;
type OnStepCallback = (stepNumber: number, toolCalls: IToolCallSummary[]) => Promise<void>;

interface IChatSession {
  chatId: string;
  platform: MessagePlatform;
  messageSender: MessageSender;
  photoSender: PhotoSender;
  onStepAsync?: OnStepCallback;
  tools: DynamicStructuredTool[];
  readTracker: FileReadTracker;
}

export class LangchainMainAgent {
  private static _instance: LangchainMainAgent | null = null;

  private _logger = LoggerService.getInstance();
  private _checkpointer: SqliteSaver | null = null;
  private _sessions: Map<string, IChatSession> = new Map();
  private _abortControllers: Map<string, AbortController> = new Map();
  private _baseSystemPrompt: string = "";
  private _aiConfig: IAiConfig | null = null;

  public static getInstance(): LangchainMainAgent {
    if (!LangchainMainAgent._instance) {
      LangchainMainAgent._instance = new LangchainMainAgent();
    }
    return LangchainMainAgent._instance;
  }

  private constructor() {}

  public async initializeAsync(): Promise<void> {
    this._baseSystemPrompt = await PromptService.getInstance().getPromptAsync("main-agent");
    this._aiConfig = ConfigService.getInstance().getConfig().ai;
    this._checkpointer = await this._createCheckpointer();
    this._logger.info("LangchainMainAgent initialized", {
      systemPromptLength: this._baseSystemPrompt.length,
    });
    await this._saveSystemPromptDebugFileAsync("main-agent", this._baseSystemPrompt);
  }

  private async _saveSystemPromptDebugFileAsync(name: string, content: string): Promise<void> {
    const debugDir = path.join(os.homedir(), ".blackdogbot", "debug");
    await fs.mkdir(debugDir, { recursive: true }).catch(() => {});
    const debugPath = path.join(debugDir, `system-prompt-${name}.txt`);
    await fs.writeFile(debugPath, content, "utf-8");
    this._logger.debug("System prompt saved to debug file", { path: debugPath });
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
    const effectivePlatform = platform ?? "telegram";
    const readTracker = new FileReadTracker();
    const permission = this._getPermissionForChat(effectivePlatform, chatId);
    const tools = await this._buildToolsForChatAsync(permission, messageSender, readTracker);

    this._sessions.set(chatId, {
      chatId,
      platform: effectivePlatform,
      messageSender,
      photoSender,
      onStepAsync,
      tools,
      readTracker,
    });

   ToolHotReloadService.getInstance().registerRebuildCallback(chatId, (perTableTools) => {
      this._rebuildToolsForChat(chatId, perTableTools);
    });

    this._logger.info("Session initialized", { chatId, platform: effectivePlatform, toolCount: tools.length });
  }

  private _getPermissionForChat(platform: MessagePlatform, chatId: string): ChannelPermission {
    const channelRegistry = ChannelRegistryService.getInstance();
    const channel = channelRegistry.getChannel(platform, chatId);
    return channel?.permission ?? "full";
  }

  private async _buildToolsForChatAsync(
    permission: ChannelPermission,
    _messageSender: MessageSender,
    readTracker: FileReadTracker,
  ): Promise<DynamicStructuredTool[]> {
    const allTools: Record<string, DynamicStructuredTool> = {};
    const supportsVision = AiCapabilityService.getInstance().getSupportsVision();

    allTools.think = thinkTool;
    allTools.run_cmd = runCmdTool;
    allTools.run_cmd_input = runCmdInputTool;
    allTools.get_cmd_status = getCmdStatusTool;
    allTools.get_cmd_output = getCmdOutputTool;
    allTools.wait_for_cmd = waitForCmdTool;
    allTools.stop_cmd = stopCmdTool;
    allTools.modify_prompt = modifyPromptTool;
    allTools.list_prompts = listPromptsTool;
    allTools.search_knowledge = searchKnowledgeTool;
    allTools.add_knowledge = addKnowledgeTool;
    allTools.edit_knowledge = editKnowledgeTool;
    allTools.fetch_rss = fetchRssTool;
    allTools.searxng = searxngTool;
    allTools.crawl4ai = crawl4aiTool;
    allTools.list_databases = listDatabasesTool;
    allTools.list_tables = listTablesTool;
    allTools.get_table_schema = getTableSchemaTool;
    allTools.create_database = createDatabaseTool;
    allTools.create_table = createTableTool;
    allTools.drop_table = dropTableTool;
    allTools.read_from_database = readFromDatabaseTool;
    allTools.update_database = updateDatabaseTool;
    allTools.delete_from_database = deleteFromDatabaseTool;
    allTools.read_file = createReadFileTool(readTracker);
    allTools.write_file = createWriteFileTool(readTracker);
    allTools.append_file = appendFileTool;
    allTools.edit_file = editFileTool;
    allTools.add_cron = addCronTool;
    allTools.remove_cron = removeCronTool;
    allTools.list_crons = listCronsTool;
    allTools.get_cron = getCronTool;
    allTools.edit_cron = editCronTool;
    allTools.edit_cron_instructions = editCronInstructionsTool;
    allTools.run_cron = runCronTool;

    if (supportsVision) {
      allTools.read_image = createReadImageTool(readTracker);
    }

    const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
    if (availableSkills.length > 0) {
      const skillNames = availableSkills.map((s) => s.name);
      allTools.call_skill = createCallSkillTool(skillNames);
      allTools.get_skill_file = getSkillFileTool;
    }

    const mcpTools = LangchainMcpService.getInstance().getTools();
    for (const tool of mcpTools) {
      allTools[tool.name] = tool;
    }

    const perTableTools = await buildPerTableToolsAsync();
    for (const [name, tool] of Object.entries(perTableTools)) {
      allTools[name] = tool as DynamicStructuredTool;
    }

    const skillNames = availableSkills.map((s) => s.name);
    const filteredTools: DynamicStructuredTool[] = [];
    for (const [toolName, tool] of Object.entries(allTools)) {
      if (toolRegistry.isToolAllowed(toolName, permission, { skillNames })) {
        filteredTools.push(tool);
      }
    }

    return filteredTools;
  }

  private _rebuildToolsForChat(chatId: string, perTableTools: Record<string, DynamicStructuredTool>): void {
    const session = this._sessions.get(chatId);
    if (!session) {
      return;
    }

    const newTools: DynamicStructuredTool[] = [...session.tools];
    for (const [name, tool] of Object.entries(perTableTools)) {
      const existingIndex = newTools.findIndex((t) => t.name === name);
      if (existingIndex >= 0) {
        newTools[existingIndex] = tool;
      } else {
        newTools.push(tool);
      }
    }
    session.tools = newTools;

    this._logger.info("Tools hot-reloaded", { chatId, newToolCount: newTools.length });
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

    thinkTracker.reset();

    const abortController = new AbortController();
    this._abortControllers.set(chatId, abortController);

    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const agent = createLangchainAgent({
          aiConfig: this._aiConfig,
          systemPrompt: this._baseSystemPrompt,
          tools: session.tools,
          checkpointer: this._checkpointer,
        });

        const result = await invokeAgentAsync(
          agent,
          userMessage,
          chatId,
          imageAttachments,
          session.onStepAsync,
        );

        return {
          text: result.text,
          stepsCount: result.stepsCount,
        };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isContextExceededApiError(error)) {
          this._logger.warn("Context limit exceeded, clearing checkpoint and retrying", {
            chatId,
            attempt: attempt + 1,
            maxRetries,
          });

          if (this._checkpointer) {
            this._checkpointer.deleteThread(chatId);
          }

          if (attempt < maxRetries - 1) {
            continue;
          }
        }

        throw lastError;
      } finally {
        this._abortControllers.delete(chatId);
      }
    }

    throw lastError ?? new Error("Unexpected error in processMessageForChatAsync");
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

  public compactSessionMessagesForChatAsync(chatId: string): Promise<boolean> {
    const session = this._sessions.get(chatId);
    if (!session) {
      return Promise.resolve(false);
    }
    this._logger.info("Compaction requested for chat (clearing LangGraph checkpoint)", { chatId });
    if (this._checkpointer) {
      this._checkpointer.deleteThread(chatId);
    }
    return Promise.resolve(true);
  }

  public clearChatHistory(chatId: string): void {
    this._sessions.delete(chatId);
    this._abortControllers.delete(chatId);
    ToolHotReloadService.getInstance().unregisterRebuildCallback(chatId);
    if (this._checkpointer) {
      this._checkpointer.deleteThread(chatId);
      this._logger.info("LangGraph checkpoint cleared", { chatId });
    }
    this._logger.info("Chat history cleared", { chatId });
  }

  public clearAllChatHistory(): void {
    const chatIds = Array.from(this._sessions.keys());
    for (const chatId of chatIds) {
      ToolHotReloadService.getInstance().unregisterRebuildCallback(chatId);
      if (this._checkpointer) {
        this._checkpointer.deleteThread(chatId);
      }
    }
    this._sessions.clear();
    this._abortControllers.clear();
    this._logger.info("All chat history cleared", { count: chatIds.length });
  }

  public async refreshAllSessionsAsync(): Promise<IRefreshSessionsResult> {
    this._baseSystemPrompt = await PromptService.getInstance().getPromptAsync("main-agent");

    const refreshedCount = this._sessions.size;
    const failedChatIds: string[] = [];

    for (const [chatId, session] of this._sessions) {
      const permission = this._getPermissionForChat(session.platform, chatId);
      session.tools = await this._buildToolsForChatAsync(
        permission,
        session.messageSender,
        session.readTracker,
      );
    }

    this._logger.info("All sessions refreshed", { refreshedCount });

    return {
      refreshedCount,
      failedCount: failedChatIds.length,
      failedChatIds,
    };
  }
}