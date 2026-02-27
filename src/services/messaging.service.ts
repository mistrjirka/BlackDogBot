import { Bot, InputFile } from "grammy";

import { LoggerService } from "./logger.service.js";
import { splitTelegramMessage } from "../utils/telegram-message.js";
import {
  type IOutgoingMessage,
  type IOutgoingPhoto,
  type MessagePlatform,
} from "../shared/types/messaging.types.js";

//#region Interfaces

export interface IPlatformAdapter {
  platform: MessagePlatform;
  sendMessageAsync(message: IOutgoingMessage): Promise<string | null>;
  sendPhotoAsync(photo: IOutgoingPhoto): Promise<string | null>;
  sendChatActionAsync(userId: string, action: string): Promise<void>;
}

//#endregion Interfaces

//#region MessagingService

export class MessagingService {
  //#region Data members

  private static _instance: MessagingService | null;
  private _logger: LoggerService;
  private _adapters: Map<MessagePlatform, IPlatformAdapter>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._adapters = new Map<MessagePlatform, IPlatformAdapter>();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): MessagingService {
    if (!MessagingService._instance) {
      MessagingService._instance = new MessagingService();
    }

    return MessagingService._instance;
  }

  public registerAdapter(adapter: IPlatformAdapter): void {
    this._adapters.set(adapter.platform, adapter);
    this._logger.info("Messaging adapter registered", { platform: adapter.platform });
  }

  public async sendMessageAsync(message: IOutgoingMessage): Promise<string | null> {
    const adapter: IPlatformAdapter | undefined = this._adapters.get(message.platform);

    if (!adapter) {
      this._logger.error("No adapter registered for platform", { platform: message.platform });
      throw new Error(`No messaging adapter registered for platform: ${message.platform}`);
    }

    const messageId: string | null = await adapter.sendMessageAsync(message);

    this._logger.debug("Message sent via adapter", {
      platform: message.platform,
      userId: message.userId,
      messageId,
    });

    return messageId;
  }

  public async sendPhotoAsync(photo: IOutgoingPhoto): Promise<string | null> {
    const adapter: IPlatformAdapter | undefined = this._adapters.get(photo.platform);

    if (!adapter) {
      this._logger.error("No adapter registered for platform", { platform: photo.platform });
      throw new Error(`No messaging adapter registered for platform: ${photo.platform}`);
    }

    const messageId: string | null = await adapter.sendPhotoAsync(photo);

    this._logger.debug("Photo sent via adapter", {
      platform: photo.platform,
      userId: photo.userId,
      messageId,
    });

    return messageId;
  }

  public async sendChatActionAsync(platform: MessagePlatform, userId: string, action: string): Promise<void> {
    const adapter: IPlatformAdapter | undefined = this._adapters.get(platform);

    if (!adapter) {
      return;
    }

    await adapter.sendChatActionAsync(userId, action);
  }

  public createSenderForChat(platform: MessagePlatform, userId: string): (message: string) => Promise<string | null> {
    return async (message: string): Promise<string | null> => {
      const outgoing: IOutgoingMessage = {
        text: message,
        platform,
        userId,
        replyToMessageId: null,
      };

      return this.sendMessageAsync(outgoing);
    };
  }

  public createPhotoSenderForChat(
    platform: MessagePlatform,
    userId: string,
  ): (imageBuffer: Buffer, caption: string | null) => Promise<string | null> {
    return async (imageBuffer: Buffer, caption: string | null): Promise<string | null> => {
      const outgoing: IOutgoingPhoto = {
        imageBuffer,
        caption,
        platform,
        userId,
      };

      return this.sendPhotoAsync(outgoing);
    };
  }

  //#endregion Public methods
}

//#endregion MessagingService

//#region TelegramAdapter

export class TelegramAdapter implements IPlatformAdapter {
  //#region Data members

  public readonly platform: MessagePlatform;
  private _bot: Bot;

  //#endregion Data members

  //#region Constructors

  constructor(bot: Bot) {
    this.platform = "telegram";
    this._bot = bot;
  }

  //#endregion Constructors

  //#region Public methods

  public async sendMessageAsync(message: IOutgoingMessage): Promise<string | null> {
    const chatId: string = message.userId;
    const chunks: string[] = splitTelegramMessage(message.text);
    let lastMessageId: string | null = null;
    for (const chunk of chunks) {
      try {
        // Try sending with Markdown formatting first
        const sentMessage = await this._bot.api.sendMessage(chatId, chunk, {
          parse_mode: "Markdown",
        });
        lastMessageId = String(sentMessage.message_id);
      } catch (error: unknown) {
        // If Markdown parsing fails (e.g. unmatched _ or *), retry as plain text.
        // This handles LLM-generated text that contains accidental markdown characters.
        const isParseError: boolean =
          error instanceof Error && error.message.includes("can't parse entities");
        if (isParseError) {
          const sentMessage = await this._bot.api.sendMessage(chatId, chunk);
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
      },
    );

    return String(sentMessage.message_id);
  }

  public async sendChatActionAsync(userId: string, action: string): Promise<void> {
    await this._bot.api.sendChatAction(userId, action as "typing");
  }

  //#endregion Public methods
}

//#endregion TelegramAdapter
