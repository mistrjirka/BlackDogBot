import { Bot, InputFile } from "grammy";

import type { IPlatformAdapter } from "../../services/messaging.service.js";
import type {
  IOutgoingMessage,
  IOutgoingPhoto,
  MessagePlatform,
} from "../../shared/types/messaging.types.js";
import { splitTelegramMessage } from "../../utils/telegram-message.js";
import { markdownToTelegramHtml, stripAllHtml } from "../../utils/telegram-format.js";

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
    const htmlText: string = markdownToTelegramHtml(message.text);
    const chunks: string[] = splitTelegramMessage(htmlText);
    let lastMessageId: string | null = null;

    for (const chunk of chunks) {
      try {
        const sentMessage = await this._bot.api.sendMessage(chatId, chunk, {
          parse_mode: "HTML",
        });
        lastMessageId = String(sentMessage.message_id);
      } catch (error: unknown) {
        const isParseError: boolean =
          error instanceof Error && error.message.includes("can't parse entities");
        if (isParseError) {
          const plainText: string = stripAllHtml(chunk);
          const sentMessage = await this._bot.api.sendMessage(chatId, plainText);
          lastMessageId = String(sentMessage.message_id);
        } else {
          throw error;
        }
      }
    }

    return lastMessageId;
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

  public async sendChatActionAsync(userId: string, action: string): Promise<void> {
    await this._bot.api.sendChatAction(userId, action as "typing");
  }

  //#endregion Public Methods
}

//#endregion TelegramAdapter
