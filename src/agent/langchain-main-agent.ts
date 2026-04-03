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
import type { IRebuildResult } from "../services/tool-hot-reload.service.js";
import { createLangchainAgent, invokeAgentAsync } from "./langchain-agent.js";
import { isContextExceededApiError, isLlamaCppParseError } from "../utils/context-error.js";
import { getDisableThinkingOnRetry } from "../services/langchain-model.service.js";
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
  removeCronTool,
  listCronsTool,
  getCronTool,
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
  deleteFromDatabaseTool,
  searxngTool,
  crawl4aiTool,
  FileReadTracker,
} from "../tools/index.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import { buildCronToolsAsync } from "../tools/build-cron-tools.js";

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
  lastAddedTableNames: string[];
  lastDroppedTableNames: string[];
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
    await this._recoverCorruptedCheckpointDb(dbPath);
    return SqliteSaver.fromConnString(dbPath);
  }

  private async _recoverCorruptedCheckpointDb(dbPath: string): Promise<void> {
    const shmPath = `${dbPath}-shm`;
    const walPath = `${dbPath}-wal`;

    try {
      const [dbStats, shmStats, walStats] = await Promise.all([
        fs.stat(dbPath).catch(() => null),
        fs.stat(shmPath).catch(() => null),
        fs.stat(walPath).catch(() => null),
      ]);

      const isCorrupted = (dbStats !== null && dbStats.size === 0)
        || (dbStats === null && (shmStats !== null || walStats !== null));

      if (isCorrupted) {
        await fs.unlink(dbPath).catch(() => {});
        await fs.unlink(shmPath).catch(() => {});
        await fs.unlink(walPath).catch(() => {});
        this._logger.warn("Recovered corrupted checkpointer database", { dbPath });
      }
    } catch {
      // Nothing to recover
    }
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
    const tools = await this._buildToolsForChatAsync(permission, readTracker);

    this._sessions.set(chatId, {
      chatId,
      platform: effectivePlatform,
      messageSender,
      photoSender,
      onStepAsync,
      tools,
      readTracker,
      lastAddedTableNames: [],
      lastDroppedTableNames: [],
    });

    ToolHotReloadService.getInstance().unregisterRebuildCallback(chatId);
    ToolHotReloadService.getInstance().registerRebuildCallback(chatId, (result: IRebuildResult) => {
      this._rebuildToolsForChat(chatId, result);
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
    allTools.delete_from_database = deleteFromDatabaseTool;
    allTools.read_file = createReadFileTool(readTracker);
    allTools.write_file = createWriteFileTool(readTracker);
    allTools.append_file = appendFileTool;
    allTools.edit_file = editFileTool;
    allTools.remove_cron = removeCronTool;
    allTools.list_crons = listCronsTool;
    allTools.get_cron = getCronTool;
    allTools.run_cron = runCronTool;

    const cronTools = await buildCronToolsAsync();
    allTools.add_cron = cronTools.add_cron;
    allTools.edit_cron = cronTools.edit_cron;
    allTools.edit_cron_instructions = cronTools.edit_cron_instructions;

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

  private _rebuildToolsForChat(chatId: string, result: IRebuildResult): void {
    const session = this._sessions.get(chatId);
    if (!session) {
      return;
    }

    const perTableToolNames = Object.keys(result.perTableTools);
    
    if (perTableToolNames.length === 0 && result.addedTableNames.length === 0) {
      this._logger.warn("Hot-rebuild returned empty tools, skipping tool replacement", { chatId });
      return;
    }

    const newTools = session.tools.filter(t => 
      !t.name.startsWith("write_table_") && 
      !t.name.startsWith("update_table_") &&
      !["add_cron", "edit_cron", "edit_cron_instructions"].includes(t.name)
    );
    
    for (const tool of Object.values(result.perTableTools)) {
      newTools.push(tool);
    }
    
    if (result.cronTools) {
      newTools.push(result.cronTools.add_cron);
      newTools.push(result.cronTools.edit_cron);
      newTools.push(result.cronTools.edit_cron_instructions);
    }
    
    session.tools = newTools;

    this._logger.info("Tools hot-reloaded", { 
      chatId, 
      newToolCount: newTools.length,
      perTableToolNames,
      addedTableNames: result.addedTableNames,
    });
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

    const maxContextRetries = 2;
    const maxHotReloadCycles = 20;
    let lastError: Error | null = null;
    let totalStepsCount: number = 0;
    let shouldResumeWithoutInput: boolean = false;
    let hotReloadCycles: number = 0;
    const tableMutationTools: ReadonlySet<string> = new Set(["create_table", "drop_table"]);

    let contextRetryAttempt = 0;
    let parseRetryAttempt = false;
    while (true) {
      try {
        const agent = createLangchainAgent({
          aiConfig: this._aiConfig,
          systemPrompt: this._baseSystemPrompt,
          tools: session.tools,
          checkpointer: this._checkpointer,
          disableThinking: parseRetryAttempt,
        });

        const result = await invokeAgentAsync(
          agent,
          shouldResumeWithoutInput ? null : userMessage,
          chatId,
          shouldResumeWithoutInput ? undefined : imageAttachments,
          session.onStepAsync,
          async (toolName: string, toolInput: unknown, toolOutput: unknown, isError: boolean): Promise<boolean> => {
            this._logger.debug("Tools available after step", {
              chatId,
              endedToolName: toolName,
              toolCount: session.tools.length,
              toolNames: session.tools.map((tool: DynamicStructuredTool): string => tool.name),
            });

            if (!tableMutationTools.has(toolName)) {
              return false;
            }

            let outputRecord: Record<string, unknown> | null = null;
            let parseSource: string = "none";

            if (typeof toolOutput === "string") {
              parseSource = "raw_string";
              try {
                const parsedUnknown: unknown = JSON.parse(toolOutput);
                if (typeof parsedUnknown === "object" && parsedUnknown !== null) {
                  outputRecord = parsedUnknown as Record<string, unknown>;
                }
              } catch {
                outputRecord = null;
              }
            } else if (typeof toolOutput === "object" && toolOutput !== null) {
              const toolOutputRecord: Record<string, unknown> = toolOutput as Record<string, unknown>;

              if (toolOutputRecord.lc === 1 && typeof toolOutputRecord.kwargs === "object" && toolOutputRecord.kwargs !== null) {
                parseSource = "tool_message_kwargs_content";
                const kwargsRecord: Record<string, unknown> = toolOutputRecord.kwargs as Record<string, unknown>;
                const contentUnknown: unknown = kwargsRecord.content;

                if (typeof contentUnknown === "string") {
                  try {
                    const parsedUnknown: unknown = JSON.parse(contentUnknown);
                    if (typeof parsedUnknown === "object" && parsedUnknown !== null) {
                      outputRecord = parsedUnknown as Record<string, unknown>;
                    }
                  } catch {
                    outputRecord = null;
                  }
                } else if (typeof contentUnknown === "object" && contentUnknown !== null) {
                  outputRecord = contentUnknown as Record<string, unknown>;
                }
              } else {
                parseSource = "plain_object";
                outputRecord = toolOutputRecord;

                if (typeof outputRecord.success !== "boolean") {
                  const statusUnknown: unknown = toolOutputRecord.status;
                  const contentUnknown: unknown = toolOutputRecord.content;

                  if (statusUnknown === "success") {
                    if (typeof contentUnknown === "string") {
                      try {
                        const parsedUnknown: unknown = JSON.parse(contentUnknown);
                        if (typeof parsedUnknown === "object" && parsedUnknown !== null) {
                          const parsedRecord: Record<string, unknown> = parsedUnknown as Record<string, unknown>;
                          outputRecord = {
                            ...parsedRecord,
                            success: parsedRecord.success === true,
                          };
                        }
                        // If parsed but not an object, leave outputRecord unchanged (fail closed)
                      } catch {
                        // JSON parse failure — do NOT default to success; leave outputRecord unchanged
                        this._logger.warn("Tool output status is success but content is not valid JSON", {
                          contentPreview: typeof contentUnknown === "string" ? contentUnknown.slice(0, 200) : "non-string",
                        });
                      }
                    }
                    // If content is not a string, leave outputRecord unchanged (fail closed)
                  }
                }
              }
            }

            const wasSuccessful: boolean = !isError && outputRecord?.success === true;
            if (!wasSuccessful) {
              this._logger.info("Skipping tool hot-reload because table mutation tool did not succeed", {
                chatId,
                toolName,
                isError,
                success: outputRecord?.success,
                outputType: typeof toolOutput,
                parseSource,
              });
              return false;
            }

            const toolInputRecord = toolInput as Record<string, unknown>;
            const tableName = toolInputRecord?.tableName as string | undefined;
            if (tableName && toolName === "drop_table") {
              session.lastDroppedTableNames.push(tableName);
            } else if (tableName) {
              session.lastAddedTableNames.push(tableName);
            }

            const expectedToolName: string | null = tableName
              ? toolName === "drop_table"
                ? null
                : `write_table_${tableName}`
              : null;

            // Retry logic for SQLite timing issues
            const maxRetries = 3;
            let rebuildResult: IRebuildResult;
            let hasExpectedTool = false;

            for (let attempt = 0; attempt < maxRetries; attempt++) {
              rebuildResult = await ToolHotReloadService.getInstance().triggerRebuildAsync(chatId);

              hasExpectedTool = expectedToolName 
                ? session.tools.some((t: DynamicStructuredTool): boolean => t.name === expectedToolName)
                : rebuildResult.success;

              if (hasExpectedTool || attempt === maxRetries - 1) {
                break;
              }

              this._logger.warn("Tool not found after rebuild, retrying", {
                chatId,
                expectedToolName,
                attempt: attempt + 1,
                maxRetries,
              });

              await new Promise((resolve): void => {
                setTimeout(resolve, 100);
              });
            }

            this._logger.info("Tool rebuild check after table mutation", {
              chatId,
              endedToolName: toolName,
              didRebuild: rebuildResult!.success,
              expectedToolName,
              hasExpectedTool,
              toolCount: session.tools.length,
            });

            if (!hasExpectedTool) {
              throw new Error(`tool hot-reload failed to add expected tool "${expectedToolName}"`);
            }

            return rebuildResult!.success && hasExpectedTool;
          },
          totalStepsCount,
        );

        totalStepsCount += result.stepsCount;

        if (session.lastAddedTableNames?.length) {
          hotReloadCycles += 1;
          if (hotReloadCycles > maxHotReloadCycles) {
            throw new Error(`Exceeded maximum hot-reload cycles (${maxHotReloadCycles}) in one message`);
          }

          const tableNames = session.lastAddedTableNames;
          if (tableNames.length === 1) {
            userMessage = `[System] New tools "write_table_${tableNames[0]}" and "update_table_${tableNames[0]}" for the "${tableNames[0]}" table are now available. Use them to insert and update data in that table.`;
          } else {
            const writeToolNames = tableNames.map(t => `write_table_${t}`).join(", ");
            const updateToolNames = tableNames.map(t => `update_table_${t}`).join(", ");
            userMessage = `[System] New tools "${writeToolNames}" and "${updateToolNames}" are now available. Use them to insert and update data in the respective tables.`;
          }
          shouldResumeWithoutInput = false;
          session.lastAddedTableNames = [];
          continue;
        }

        if (session.lastDroppedTableNames?.length) {
          hotReloadCycles += 1;
          if (hotReloadCycles > maxHotReloadCycles) {
            throw new Error(`Exceeded maximum hot-reload cycles (${maxHotReloadCycles}) in one message`);
          }

          const tableNames = session.lastDroppedTableNames;
          if (tableNames.length === 1) {
            userMessage = `[System] The tools "write_table_${tableNames[0]}" and "update_table_${tableNames[0]}" have been removed. You can no longer write to or update the "${tableNames[0]}" table.`;
          } else {
            const writeToolNames = tableNames.map(t => `write_table_${t}`).join(", ");
            const updateToolNames = tableNames.map(t => `update_table_${t}`).join(", ");
            userMessage = `[System] The tools "${writeToolNames}" and "${updateToolNames}" have been removed. You can no longer write to or update the respective tables.`;
          }
          shouldResumeWithoutInput = false;
          session.lastDroppedTableNames = [];
          continue;
        }

        if (result.toolsChanged) {
          hotReloadCycles += 1;
          if (hotReloadCycles > maxHotReloadCycles) {
            throw new Error(`Exceeded maximum hot-reload cycles (${maxHotReloadCycles}) in one message`);
          }

          shouldResumeWithoutInput = true;
          continue;
        }

        return {
          text: result.text,
          stepsCount: totalStepsCount,
        };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isContextExceededApiError(error) && contextRetryAttempt < maxContextRetries) {
          contextRetryAttempt += 1;
          this._logger.warn("Context limit exceeded, clearing checkpoint and retrying", {
            chatId,
            attempt: contextRetryAttempt,
            maxContextRetries,
          });

          if (this._checkpointer) {
            this._checkpointer.deleteThread(chatId);
          }

          continue;
        }

        if (isLlamaCppParseError(error) && !parseRetryAttempt) {
          const disableThinking = this._aiConfig ? getDisableThinkingOnRetry(this._aiConfig) : false;
          if (disableThinking) {
            parseRetryAttempt = true;
            this._logger.warn("llama.cpp parse error detected, retrying with thinking disabled", {
              chatId,
              errorMessage: lastError.message,
            });

            if (this._checkpointer) {
              this._checkpointer.deleteThread(chatId);
            }

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

  public async resetCheckpointerAsync(): Promise<void> {
    const baseDir = path.join(os.homedir(), ".blackdogbot");
    const dbPath = path.join(baseDir, "chat-checkpoints.db");
    await fs.unlink(dbPath).catch(() => {});
    await fs.unlink(`${dbPath}-shm`).catch(() => {});
    await fs.unlink(`${dbPath}-wal`).catch(() => {});
    this._checkpointer = await this._createCheckpointer();
    this._logger.info("Checkpointer reset");
  }

  public async refreshAllSessionsAsync(): Promise<IRefreshSessionsResult> {
    this._baseSystemPrompt = await PromptService.getInstance().getPromptAsync("main-agent");

    const refreshedCount = this._sessions.size;
    const failedChatIds: string[] = [];

    for (const [chatId, session] of this._sessions) {
      const permission = this._getPermissionForChat(session.platform, chatId);
      session.tools = await this._buildToolsForChatAsync(
        permission,
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
