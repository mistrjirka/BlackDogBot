import { Context } from "grammy";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";

import { LoggerService } from "../../services/logger.service.js";
import { MessagingService } from "../../services/messaging.service.js";
import { MainAgent } from "../../agent/main-agent.js";
import { ChannelRegistryService } from "../../services/channel-registry.service.js";
import type { IAgentResult, OnStepCallback, IToolCallSummary } from "../../agent/base-agent.js";
import type { IIncomingMessage } from "../../shared/types/messaging.types.js";
import type { IPlatformDeps } from "../types.js";
import type { ITelegramConfig } from "./types.js";
import { generateId } from "../../utils/id.js";
import { splitTelegramMessage } from "../../utils/telegram-message.js";
import {
  extractAiErrorDetails,
  formatAiErrorForLog,
  formatAiErrorForUser,
  type IAiErrorDetails,
} from "../../utils/ai-error.js";
import { extractErrorMessage } from "../../utils/error.js";
import { sanitizeTelegramHtml, stripAllHtml } from "../../utils/telegram-format.js";

//#region Constants

const TOOL_PRIMARY_KEY: Record<string, string> = {
  run_cmd: "command",
  fetch_rss: "url",
  search_knowledge: "query",
  add_knowledge: "knowledge",
  edit_knowledge: "id",
  add_job: "name",
  edit_job: "jobId",
  remove_job: "jobId",
  run_job: "jobId",
  finish_job: "jobId",
  edit_node: "nodeId",
  remove_node: "nodeId",
  connect_nodes: "fromNodeId",
  set_entrypoint: "nodeId",
  call_skill: "skillName",
  get_skill_file: "skillName",
  modify_prompt: "promptName",
  send_message: "message",
  read_file: "filePath",
  write_file: "filePath",
  append_file: "filePath",
  edit_file: "filePath",
  render_graph: "jobId",
  add_cron: "name",
  remove_cron: "taskId",
  think: "thought",
  done: "summary",
};

//#endregion Constants

//#region TelegramHandler

export class TelegramHandler {
  //#region Data Members

  private static _instance: TelegramHandler | null;
  private _logger: LoggerService;
  private _messagingService: MessagingService;
  private _mainAgent: MainAgent;
  private _channelRegistry: ChannelRegistryService;
  private _processing: Set<string>;
  private _pendingMessages: Map<string, string[]>;
  private _knownChatIds: Set<string>;
  private _chatIdsFilePath: string;
  private _config: ITelegramConfig | null = null;

  //#endregion Data Members

  //#region Constructor

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._messagingService = MessagingService.getInstance();
    this._mainAgent = MainAgent.getInstance();
    this._channelRegistry = ChannelRegistryService.getInstance();
    this._processing = new Set<string>();
    this._pendingMessages = new Map<string, string[]>();
    this._knownChatIds = new Set<string>();

    const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
    this._chatIdsFilePath = join(homeDir, ".betterclaw", "known-telegram-chats.json");
  }

  //#endregion Constructor

  //#region Public Methods

  public static getInstance(): TelegramHandler {
    if (!TelegramHandler._instance) {
      TelegramHandler._instance = new TelegramHandler();
    }
    return TelegramHandler._instance;
  }

  public async initializeAsync(config: ITelegramConfig, _deps: IPlatformDeps): Promise<void> {
    this._config = config;

    await this._loadKnownChatIdsAsync();

    const allowedUsers = config.allowedUsers;

    if (allowedUsers && allowedUsers.length > 0) {
      this._knownChatIds = new Set(allowedUsers);
      await this._saveKnownChatIdsAsync();
      this._logger.info("Telegram allowedUsers set in config, using that as authorized users");
    }
  }

  public getKnownChatIds(): string[] {
    return Array.from(this._knownChatIds);
  }

  public async handleMessageAsync(ctx: Context): Promise<void> {
    const message = ctx.message;

    if (!message || !message.text) {
      return;
    }

    const chatId: string = String(message.chat.id);

    if (!(await this._isAuthorizedAsync(chatId))) {
      return;
    }

    // Auto-register channel if not exists
    if (!this._channelRegistry.hasChannel("telegram", chatId)) {
      await this._channelRegistry.registerChannelAsync("telegram", chatId, {
        permission: "full",
        receiveNotifications: true,
      });
      this._logger.info("Auto-registered Telegram channel", { chatId });
    }

    // Prevent concurrent processing per chat
    if (this._processing.has(chatId)) {
      const pendingForChat: string[] = this._pendingMessages.get(chatId) ?? [];
      pendingForChat.push(message.text);
      this._pendingMessages.set(chatId, pendingForChat);

      this._logger.info("Queued Telegram message while previous one is still processing", {
        chatId,
        queuedCount: pendingForChat.length,
      });

      return;
    }

    this._processing.add(chatId);

    // Progress message state
    let progressMsgId: number | null = null;
    const stepLogs: string[] = [];

    const buildProgressText = (status: string): string => {
      if (stepLogs.length === 0) {
        return status;
      }
      return `${status}\n\n<blockquote expandable>${stepLogs.join("\n")}</blockquote>`;
    };

    try {
      const incoming: IIncomingMessage = {
        id: generateId(),
        platform: "telegram",
        text: message.text,
        userId: chatId,
        userName: message.from?.username ?? message.from?.first_name ?? null,
        timestamp: message.date * 1000,
        raw: message,
      };

      this._logger.info("Received Telegram message", {
        chatId,
        userName: incoming.userName,
        textLength: incoming.text.length,
      });

      // Initialize the main agent with a sender bound to this chat
      const sender = this._messagingService.createSenderForChat("telegram", chatId);
      const photoSender = this._messagingService.createPhotoSenderForChat("telegram", chatId);

      // Send initial progress message
      try {
        const progressMsg = await ctx.reply("⚙️ Working...", { parse_mode: "HTML" });
        progressMsgId = progressMsg.message_id;
      } catch {
        // Continue without progress message
      }

      const onStepAsync: OnStepCallback | undefined =
        progressMsgId !== null
          ? async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
              if (toolCalls.length > 0) {
                const formatted: string = toolCalls
                  .map((tc: IToolCallSummary): string => _formatToolCall(tc.name, tc.input))
                  .join(", ");
                stepLogs.push(`Step ${stepNumber}: ${formatted}`);
              }

              try {
                await ctx.api.editMessageText(chatId, progressMsgId!, buildProgressText("⚙️ Working..."), {
                  parse_mode: "HTML",
                });
              } catch {
                // Ignore edit failures
              }
            }
          : undefined;

      await this._mainAgent.initializeForChatAsync(chatId, sender, photoSender, onStepAsync, "telegram");

      // Start typing indicator
      const typingInterval: ReturnType<typeof setInterval> = setInterval(async () => {
        try {
          await this._messagingService.sendChatActionAsync("telegram", chatId, "typing");
        } catch {
          // Silently ignore typing indicator failures
        }
      }, 5000);

      await this._messagingService.sendChatActionAsync("telegram", chatId, "typing").catch(() => {});

      try {
        const result: IAgentResult = await this._mainAgent.processMessageForChatAsync(
          chatId,
          incoming.text
        );

        // Update progress message to done
        if (progressMsgId !== null) {
          try {
            const stepWord: string = result.stepsCount === 1 ? "step" : "steps";
            await ctx.api.editMessageText(
              chatId,
              progressMsgId,
              buildProgressText(`✅ Done (${result.stepsCount} ${stepWord})`),
              { parse_mode: "HTML" }
            );
          } catch {
            // Ignore
          }
        }

        // Send response
        if (result.text) {
          const sanitizedText: string = sanitizeTelegramHtml(result.text);
          const chunks: string[] = splitTelegramMessage(sanitizedText);
          for (let i: number = 0; i < chunks.length; i++) {
            const options: Record<string, unknown> = {
              parse_mode: "HTML",
            };
            if (i === 0) {
              options.reply_parameters = { message_id: message.message_id };
            }
            try {
              await ctx.reply(chunks[i], options);
            } catch (parseError: unknown) {
              this._logger.warn("Telegram HTML parse error, falling back to plain text", {
                error: parseError instanceof Error ? parseError.message : String(parseError),
              });
              const plainText: string = stripAllHtml(chunks[i]);
              const fallbackOptions: Record<string, unknown> =
                i === 0 ? { reply_parameters: { message_id: message.message_id } } : {};
              await ctx.reply("⚠️ Formatting error, showing plain text:", fallbackOptions);
              await ctx.reply(plainText, fallbackOptions);
            }
          }
        }

        this._logger.info("Telegram message processed", {
          chatId,
          stepsCount: result.stepsCount,
          responseLength: result.text.length,
        });
      } finally {
        clearInterval(typingInterval);
      }
    } catch (error: unknown) {
      // Update progress message to error state
      if (progressMsgId !== null) {
        try {
          await ctx.api.editMessageText(chatId, progressMsgId, buildProgressText("❌ Error"), {
            parse_mode: "HTML",
          });
        } catch {
          // Ignore
        }
      }

      const errorDetails: IAiErrorDetails = extractAiErrorDetails(error);
      const logMessage: string = formatAiErrorForLog(errorDetails);

      this._logger.error("Error processing Telegram message", {
        chatId,
        error: logMessage,
        statusCode: errorDetails.statusCode,
        provider: errorDetails.provider,
        model: errorDetails.model,
        retryable: errorDetails.isRetryable,
      });

      try {
        const userMessage: string = formatAiErrorForUser(errorDetails);
        await ctx.reply(userMessage);
      } catch (replyError: unknown) {
        this._logger.error("Failed to send error reply", {
          chatId,
          error: replyError instanceof Error ? replyError.message : String(replyError),
        });
      }
    } finally {
      this._processing.delete(chatId);

      const pendingForChat: string[] | undefined = this._pendingMessages.get(chatId);

      if (pendingForChat && pendingForChat.length > 0) {
        this._pendingMessages.delete(chatId);

        const mergedMessage: string = pendingForChat.join("\n");

        void this._processMergedQueuedMessageAsync(chatId, mergedMessage);
      }
    }
  }

  //#endregion Public Methods

  //#region Private Methods

  private async _loadKnownChatIdsAsync(): Promise<void> {
    try {
      if (existsSync(this._chatIdsFilePath)) {
        const data = await readFile(this._chatIdsFilePath, "utf-8");
        const chatIds: string[] = JSON.parse(data);
        this._knownChatIds = new Set(chatIds);
        this._logger.info(`Loaded ${chatIds.length} known Telegram chat IDs`);
      }
    } catch (error) {
      this._logger.warn("Failed to load known Telegram chat IDs", {
        error: extractErrorMessage(error),
      });
    }
  }

  private async _saveKnownChatIdsAsync(): Promise<void> {
    try {
      const dir = dirname(this._chatIdsFilePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      const chatIds = Array.from(this._knownChatIds);
      await writeFile(this._chatIdsFilePath, JSON.stringify(chatIds, null, 2));
    } catch (error) {
      this._logger.warn("Failed to save known Telegram chat IDs", {
        error: extractErrorMessage(error),
      });
    }
  }

  private async _processMergedQueuedMessageAsync(chatId: string, mergedText: string): Promise<void> {
    if (this._processing.has(chatId)) {
      const pendingForChat: string[] = this._pendingMessages.get(chatId) ?? [];
      pendingForChat.push(mergedText);
      this._pendingMessages.set(chatId, pendingForChat);
      return;
    }

    this._processing.add(chatId);

    try {
      this._logger.info("Processing merged queued Telegram messages", {
        chatId,
        mergedLength: mergedText.length,
      });

      const sender = this._messagingService.createSenderForChat("telegram", chatId);
      const photoSender = this._messagingService.createPhotoSenderForChat("telegram", chatId);

      await this._mainAgent.initializeForChatAsync(chatId, sender, photoSender, undefined, "telegram");

      await this._messagingService.sendChatActionAsync("telegram", chatId, "typing").catch(() => {});

      const result: IAgentResult = await this._mainAgent.processMessageForChatAsync(chatId, mergedText);

      if (result.text) {
        const chunks: string[] = splitTelegramMessage(result.text);
        for (const chunk of chunks) {
          await sender(chunk);
        }
      }

      this._logger.info("Merged queued Telegram messages processed", {
        chatId,
        stepsCount: result.stepsCount,
        responseLength: result.text.length,
      });
    } catch (error: unknown) {
      const errorDetails: IAiErrorDetails = extractAiErrorDetails(error);
      const logMessage: string = formatAiErrorForLog(errorDetails);

      this._logger.error("Error processing merged queued Telegram messages", {
        chatId,
        error: logMessage,
        statusCode: errorDetails.statusCode,
        provider: errorDetails.provider,
        model: errorDetails.model,
        retryable: errorDetails.isRetryable,
      });
    } finally {
      this._processing.delete(chatId);

      const pendingForChat: string[] | undefined = this._pendingMessages.get(chatId);

      if (pendingForChat && pendingForChat.length > 0) {
        this._pendingMessages.delete(chatId);
        const nextMergedMessage: string = pendingForChat.join("\n");
        void this._processMergedQueuedMessageAsync(chatId, nextMergedMessage);
      }
    }
  }

  private async _isAuthorizedAsync(chatId: string): Promise<boolean> {
    if (!this._config) return false;

    const allowedUsers = this._config.allowedUsers;

    if (allowedUsers && allowedUsers.length > 0) {
      return allowedUsers.includes(chatId);
    }

    if (this._knownChatIds.size === 0) {
      this._knownChatIds.add(chatId);
      await this._saveKnownChatIdsAsync();
      this._logger.info(`Registered first Telegram user: ${chatId}`);
      return true;
    }

    return this._knownChatIds.has(chatId);
  }

  //#endregion Private Methods
}

//#endregion TelegramHandler

//#region Private Functions

function _formatToolCall(name: string, input: Record<string, unknown>): string {
  const key: string | undefined = TOOL_PRIMARY_KEY[name];

  if (!key || !(key in input)) {
    return name;
  }

  const val: string = String(input[key] ?? "");
  const truncated: string = val.length > 60 ? val.slice(0, 60) + "…" : val;

  return `${name}(${truncated})`;
}

//#endregion Private Functions
