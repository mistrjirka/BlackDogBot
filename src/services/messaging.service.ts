import { Bot } from "grammy";

import { LoggerService } from "./logger.service.js";
import {
  type IOutgoingMessage,
  type MessagePlatform,
} from "../shared/types/messaging.types.js";

//#region Interfaces

export interface IPlatformAdapter {
  platform: MessagePlatform;
  sendMessageAsync(message: IOutgoingMessage): Promise<string | null>;
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

    const sentMessage = await this._bot.api.sendMessage(chatId, message.text, {
      parse_mode: "Markdown",
    });

    return String(sentMessage.message_id);
  }

  //#endregion Public methods
}

//#endregion TelegramAdapter
