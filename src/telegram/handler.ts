import { Context } from "grammy";

import { LoggerService } from "../services/logger.service.js";
import { MessagingService } from "../services/messaging.service.js";
import { MainAgent } from "../agent/main-agent.js";
import { type IAgentResult } from "../agent/base-agent.js";
import { type OnStepCallback } from "../agent/base-agent.js";
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

    // Progress message state — declared at method scope so catch block can update it too
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

      // Send initial progress message — failure is non-fatal
      try {
        const progressMsg = await ctx.reply("⚙️ Working...", { parse_mode: "HTML" });
        progressMsgId = progressMsg.message_id;
      } catch {
        // Continue without progress message
      }

      const onStepAsync: OnStepCallback | undefined = progressMsgId !== null
        ? async (stepNumber: number, toolNames: string[]): Promise<void> => {
            if (toolNames.length > 0) {
              stepLogs.push(`Step ${stepNumber}: ${toolNames.join(", ")}`);
            }

            try {
              await ctx.api.editMessageText(
                chatId,
                progressMsgId!,
                buildProgressText("⚙️ Working..."),
                { parse_mode: "HTML" },
              );
            } catch {
              // Ignore edit failures (rate limits, message not modified, etc.)
            }
          }
        : undefined;

      await this._mainAgent.initializeForChatAsync(chatId, sender, photoSender, onStepAsync);

      // Start typing indicator
      const typingInterval: ReturnType<typeof setInterval> = setInterval(async () => {
        try {
          await this._messagingService.sendChatActionAsync("telegram", chatId, "typing");
        } catch {
          // Silently ignore typing indicator failures
        }
      }, 5000);

      // Send initial typing action immediately
      await this._messagingService.sendChatActionAsync("telegram", chatId, "typing").catch(() => {});

      try {
        const result: IAgentResult = await this._mainAgent.processMessageForChatAsync(chatId, incoming.text);

        // Update progress message to done
        if (progressMsgId !== null) {
          try {
            const stepWord: string = result.stepsCount === 1 ? "step" : "steps";
            await ctx.api.editMessageText(
              chatId,
              progressMsgId,
              buildProgressText(`✅ Done (${result.stepsCount} ${stepWord})`),
              { parse_mode: "HTML" },
            );
          } catch {
            // Ignore
          }
        }

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
      } finally {
        clearInterval(typingInterval);
      }
    } catch (error: unknown) {
      // Update progress message to error state
      if (progressMsgId !== null) {
        try {
          await ctx.api.editMessageText(
            chatId,
            progressMsgId,
            buildProgressText("❌ Error"),
            { parse_mode: "HTML" },
          );
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
    }
  }

  //#endregion Public methods
}

//#endregion TelegramHandler
