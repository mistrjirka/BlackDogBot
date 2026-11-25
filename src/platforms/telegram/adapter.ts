import { Bot, GrammyError, InputFile } from "grammy";

import type { IPlatformAdapter } from "../../services/messaging.service.js";
import type {
  IOutgoingFile,
  IOutgoingMessage,
  IOutgoingPhoto,
  MessagePlatform,
} from "../../shared/types/messaging.types.js";
import { splitTelegramMessage } from "../../utils/telegram-message.js";
import { getTelegramRichMarkdown, markdownToTelegramHtml, stripAllHtml } from "../../utils/telegram-format.js";
import { ChatNotFoundError } from "../../utils/error.js";
import { LoggerService } from "../../services/logger.service.js";

//#region TelegramAdapter

/**
 * Adapter for sending messages via Telegram.
 * Implements IPlatformAdapter for use with MessagingService.
 */
export class TelegramAdapter implements IPlatformAdapter {
  //#region Data Members

  public readonly platform: MessagePlatform;
  private _bot: Bot;

  //#endregion Data Members

  //#region Constructor

  constructor(bot: Bot) {
    this.platform = "telegram";
    this._bot = bot;
  }

  //#endregion Constructor

  //#region Public Methods

  public async sendMessageAsync(message: IOutgoingMessage): Promise<string | null> {
    const chatId: string = message.userId;
    const replyId = Number(message.replyToMessageId);
    const replyParameters = Number.isSafeInteger(replyId) && replyId > 0
      ? { reply_parameters: { message_id: replyId, allow_sending_without_reply: true } }
      : {};
    let lastMessageId: string | null = null;

    try {
      const richMarkdown = getTelegramRichMarkdown(message.text);
      if (richMarkdown !== null) {
        try {
          const sentMessage = await this._bot.api.sendRichMessage(
            chatId, { markdown: richMarkdown }, replyParameters,
          );
          return String(sentMessage.message_id);
        } catch (error: unknown) {
          // Only fall back on an explicit rejection. Network errors and rate limits
          // must reach the existing outbox rather than triggering another send here.
          if (!(error instanceof GrammyError) ||
              (error.error_code !== 400 && error.error_code !== 404) ||
              this._isChatNotFoundError(error)) {
            throw error;
          }
          LoggerService.getInstance().warn("Telegram rejected rich message; falling back to HTML", {
            errorCode: error.error_code,
          });
        }
      }

      const htmlText: string = markdownToTelegramHtml(message.text);
      const chunks: string[] = splitTelegramMessage(htmlText);
      for (const [index, chunk] of chunks.entries()) {
        const reply = index === 0 ? replyParameters : {};
        try {
          const sentMessage = await this._bot.api.sendMessage(chatId, chunk, {
            parse_mode: "HTML",
            ...reply,
          });
          lastMessageId = String(sentMessage.message_id);
        } catch (error: unknown) {
          const isParseError: boolean =
            error instanceof Error && error.message.includes("can't parse entities");
          if (isParseError) {
            const plainText: string = stripAllHtml(chunk);
            const sentMessage = await this._bot.api.sendMessage(chatId, plainText, reply);
            lastMessageId = String(sentMessage.message_id);
          } else {
            throw error;
          }
        }
      }

      return lastMessageId;
    } catch (error: unknown) {
      if (this._isChatNotFoundError(error)) {
        throw new ChatNotFoundError(chatId);
      }
      throw error;
    }
  }

  private _isChatNotFoundError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg: string = error.message.toLowerCase();
      return msg.includes("chat not found") || msg.includes("bad request: chat not found");
    }
    return false;
  }

  public async sendPhotoAsync(photo: IOutgoingPhoto): Promise<string | null> {
    const chatId: string = photo.userId;

    const sentMessage = await this._bot.api.sendPhoto(
      chatId,
      new InputFile(photo.imageBuffer, "graph.png"),
      {
        caption: photo.caption ?? undefined,
      }
    );

    return String(sentMessage.message_id);
  }

  public async sendFileAsync(file: IOutgoingFile): Promise<string | null> {
    const chatId: string = file.userId;

    try {
      const sentMessage = await this._bot.api.sendDocument(
        chatId,
        new InputFile(file.fileBuffer, file.fileName),
        {
          caption: file.caption ?? undefined,
        },
      );

      return String(sentMessage.message_id);
    } catch (error: unknown) {
      if (this._isChatNotFoundError(error)) {
        throw new ChatNotFoundError(chatId);
      }
      throw error;
    }
  }

  public async sendChatActionAsync(userId: string, action: string): Promise<void> {
    await this._bot.api.sendChatAction(userId, action as "typing");
  }

  //#endregion Public Methods
}

//#endregion TelegramAdapter
