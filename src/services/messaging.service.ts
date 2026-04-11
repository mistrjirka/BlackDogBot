import { LoggerService } from "./logger.service.js";
import { TelegramOutboxService, type ITelegramOutboxMessage } from "./telegram-outbox.service.js";
import {
  type IOutgoingMessage,
  type IOutgoingPhoto,
  type MessagePlatform,
} from "../shared/types/messaging.types.js";
import { ChatNotFoundError, extractErrorMessage } from "../utils/error.js";

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
  private _telegramOutboxService: TelegramOutboxService;
  private _telegramOutboxTimer: NodeJS.Timeout | null;
  private _telegramOutboxPolling: boolean;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._adapters = new Map<MessagePlatform, IPlatformAdapter>();
    this._telegramOutboxService = TelegramOutboxService.getInstance();
    this._telegramOutboxTimer = null;
    this._telegramOutboxPolling = false;
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

    let messageId: string | null;

    try {
      messageId = await adapter.sendMessageAsync(message);
    } catch (error: unknown) {
      if (message.platform === "telegram" && !(error instanceof ChatNotFoundError)) {
        if (!this._telegramOutboxService.isInitialized()) {
          await this._telegramOutboxService.initializeAsync();
          this.startTelegramOutboxWorker();
        }

        const queuedId: string = this._telegramOutboxService.enqueuePendingMessage(
          message.userId,
          message.text,
          extractErrorMessage(error),
        );

        this._safeWarn("Telegram send failed, message queued in outbox", {
          chatId: message.userId,
          queuedId,
        });

        return queuedId;
      }

      throw error;
    }

    this._logger.debug("Message sent via adapter", {
      platform: message.platform,
      userId: message.userId,
      messageId,
    });

    return messageId;
  }

  public async initializeTelegramOutboxAsync(maxPendingPerChat?: number): Promise<void> {
    await this._telegramOutboxService.initializeAsync(maxPendingPerChat);
    this.startTelegramOutboxWorker();
  }

  public startTelegramOutboxWorker(intervalMs: number = 15000): void {
    if (this._telegramOutboxTimer !== null) {
      return;
    }

    this._telegramOutboxTimer = setInterval((): void => {
      void this._drainTelegramOutboxAsync();
    }, intervalMs);
  }

  public stopTelegramOutboxWorker(): void {
    if (this._telegramOutboxTimer !== null) {
      clearInterval(this._telegramOutboxTimer);
      this._telegramOutboxTimer = null;
    }
  }

  public shutdownTelegramOutbox(): void {
    this.stopTelegramOutboxWorker();
    this._telegramOutboxService.close();
  }

  private async _drainTelegramOutboxAsync(): Promise<void> {
    if (this._telegramOutboxPolling) {
      return;
    }

    const adapter: IPlatformAdapter | undefined = this._adapters.get("telegram");
    if (!adapter) {
      return;
    }

    this._telegramOutboxPolling = true;

    try {
      const dueMessages: ITelegramOutboxMessage[] = this._telegramOutboxService.getDuePendingMessages(20);
      for (const queuedMessage of dueMessages) {
        try {
          await adapter.sendMessageAsync({
            text: queuedMessage.message,
            platform: "telegram",
            userId: queuedMessage.chatId,
            replyToMessageId: null,
          });

          this._telegramOutboxService.markSent(queuedMessage.id);
          this._safeInfo("Delivered queued Telegram outbox message", {
            queuedId: queuedMessage.id,
            chatId: queuedMessage.chatId,
          });
        } catch (error: unknown) {
          if (error instanceof ChatNotFoundError) {
            this._telegramOutboxService.markPermanentFailed(queuedMessage.id, extractErrorMessage(error));
            this._safeWarn("Queued Telegram message permanently failed (chat not found)", {
              queuedId: queuedMessage.id,
              chatId: queuedMessage.chatId,
            });
            continue;
          }

          this._telegramOutboxService.reschedulePending(
            queuedMessage.id,
            queuedMessage.attempts,
            extractErrorMessage(error),
          );
        }
      }
    } finally {
      this._telegramOutboxPolling = false;
    }
  }

  private _safeInfo(message: string, context?: Record<string, unknown>): void {
    try {
      this._logger.info(message, context);
    } catch {
      // Best-effort logging only.
    }
  }

  private _safeWarn(message: string, context?: Record<string, unknown>): void {
    try {
      this._logger.warn(message, context);
    } catch {
      // Best-effort logging only.
    }
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
