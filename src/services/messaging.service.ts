import { LoggerService } from "./logger.service.js";
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

  public hasAdapter(platform: MessagePlatform): boolean {
    return this._adapters.has(platform);
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
