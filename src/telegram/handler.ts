import { Context } from "grammy";

import { LoggerService } from "../services/logger.service.js";
import { MessagingService } from "../services/messaging.service.js";
import { MainAgent } from "../agent/main-agent.js";
import { type IAgentResult } from "../agent/base-agent.js";
import { type IIncomingMessage } from "../shared/types/messaging.types.js";
import { generateId } from "../utils/id.js";
import {
  extractAiErrorDetails,
  formatAiErrorForLog,
  formatAiErrorForUser,
  type IAiErrorDetails,
} from "../utils/ai-error.js";

//#region TelegramHandler

export class TelegramHandler {
  //#region Data members

  private static _instance: TelegramHandler | null;
  private _logger: LoggerService;
  private _messagingService: MessagingService;
  private _mainAgent: MainAgent;
  private _processing: Set<string>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._messagingService = MessagingService.getInstance();
    this._mainAgent = MainAgent.getInstance();
    this._processing = new Set<string>();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): TelegramHandler {
    if (!TelegramHandler._instance) {
      TelegramHandler._instance = new TelegramHandler();
    }

    return TelegramHandler._instance;
  }

  public async handleMessageAsync(ctx: Context): Promise<void> {
    const message = ctx.message;

    if (!message || !message.text) {
      return;
    }

    const chatId: string = String(message.chat.id);

    // Prevent concurrent processing per chat
    if (this._processing.has(chatId)) {
      this._logger.warn("Already processing a message for this chat, skipping", { chatId });
      return;
    }

    this._processing.add(chatId);

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

      await this._mainAgent.initializeForChatAsync(chatId, sender);

      const result: IAgentResult = await this._mainAgent.processMessageForChatAsync(chatId, incoming.text);

      // If the agent produced text output and hasn't already sent it via send_message tool,
      // send it as a final response
      if (result.text) {
        await ctx.reply(result.text, {
          reply_parameters: { message_id: message.message_id },
        });
      }

      this._logger.info("Telegram message processed", {
        chatId,
        stepsCount: result.stepsCount,
        responseLength: result.text.length,
      });
    } catch (error: unknown) {
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
    }
  }

  //#endregion Public methods
}

//#endregion TelegramHandler
