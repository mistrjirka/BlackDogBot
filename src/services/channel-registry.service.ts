import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import yaml from "yaml";

import type {
  IChannelsConfig,
  IRegisteredChannel,
  ChannelPermission,
} from "../shared/types/channel.types.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";
import { LoggerService } from "./logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { getChannelsFilePath } from "../utils/paths.js";

//#region ChannelRegistryService

/**
 * Manages registered communication channels and their settings.
 *
 * Channels are stored in ~/.blackdogbot/channels.yaml and include:
 * - Platform and channel identifiers
 * - Permission levels
 * - Notification preferences
 *
 * This service is used by:
 * - ToolRegistryService (to check tool permissions)
 * - CronTaskExecutor (to find notification channels)
 * - Platform handlers (to register/update channels)
 */
export class ChannelRegistryService {
  //#region Singleton

  private static _instance: ChannelRegistryService | null = null;

  public static getInstance(): ChannelRegistryService {
    if (!ChannelRegistryService._instance) {
      ChannelRegistryService._instance = new ChannelRegistryService();
    }
    return ChannelRegistryService._instance;
  }

  //#endregion Singleton

  //#region Data Members

  private _logger: LoggerService;
  private _config: IChannelsConfig;
  private _filePath: string;

  //#endregion Data Members

  //#region Constructor

  private constructor() {
    this._logger = LoggerService.getInstance();

    this._filePath = getChannelsFilePath();

    this._config = {
      version: 1,
      channels: [],
    };
  }

  //#endregion Constructor

  //#region Public Methods - Lifecycle

  /**
   * Initialize the service by loading channels.yaml.
   * Must be called before using the service.
   */
  public async initializeAsync(): Promise<void> {
    await this._loadAsync();
  }

  //#endregion Public Methods - Lifecycle

  //#region Public Methods - Channel Registration

  /**
   * Register a new channel or update an existing one.
   *
   * @param platform Platform identifier (telegram, discord, etc.)
   * @param channelId Unique channel identifier on the platform
   * @param options Optional settings (permission, notifications, guildId)
   * @returns The registered channel
   */
  public async registerChannelAsync(
    platform: MessagePlatform,
    channelId: string,
    options?: {
      guildId?: string;
      permission?: ChannelPermission;
      receiveNotifications?: boolean;
    }
  ): Promise<IRegisteredChannel> {
    const existingIndex = this._config.channels.findIndex(
      (c) => c.platform === platform && c.channelId === channelId
    );

    const now = new Date().toISOString();

    if (existingIndex >= 0) {
      const existing = this._config.channels[existingIndex];

      if (options?.guildId !== undefined) existing.guildId = options.guildId;
      if (options?.permission !== undefined) existing.permission = options.permission;
      if (options?.receiveNotifications !== undefined) {
        existing.receiveNotifications = options.receiveNotifications;
      }
      existing.updatedAt = now;

      await this._saveAsync();
      this._logger.debug("Updated channel", { platform, channelId });
      return existing;
    }

    const channel: IRegisteredChannel = {
      platform,
      channelId,
      guildId: options?.guildId,
      permission:
        options?.permission ?? (platform === "telegram" ? "full" : "read_only"),
      receiveNotifications: options?.receiveNotifications ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this._config.channels.push(channel);
    await this._saveAsync();

    this._logger.info("Registered new channel", {
      platform,
      channelId,
      permission: channel.permission,
      receiveNotifications: channel.receiveNotifications,
    });

    return channel;
  }

  //#endregion Public Methods - Channel Registration

  //#region Public Methods - Notification Settings

  /**
   * Enable or disable notifications for a channel.
   *
   * @param platform Platform identifier
   * @param channelId Channel identifier
   * @param enabled Whether to enable notifications
   * @returns true if channel was found and updated, false otherwise
   */
  public async setNotificationsEnabledAsync(
    platform: string,
    channelId: string,
    enabled: boolean
  ): Promise<boolean> {
    const channel = this._config.channels.find(
      (c) => c.platform === platform && c.channelId === channelId
    );

    if (!channel) {
      this._logger.warn("Cannot set notifications: channel not found", {
        platform,
        channelId,
      });
      return false;
    }

    channel.receiveNotifications = enabled;
    channel.updatedAt = new Date().toISOString();
    await this._saveAsync();

    this._logger.info("Updated channel notifications", {
      platform,
      channelId,
      enabled,
    });

    return true;
  }

  //#endregion Public Methods - Notification Settings

  //#region Public Methods - Queries

  /**
   * Get a specific channel by platform and ID.
   */
  public getChannel(
    platform: string,
    channelId: string
  ): IRegisteredChannel | undefined {
    return this._config.channels.find(
      (c) => c.platform === platform && c.channelId === channelId
    );
  }

  /**
   * Get all channels that should receive notifications.
   * Used by CronTaskExecutor to broadcast messages.
   */
  public getNotificationChannels(): IRegisteredChannel[] {
    const channels = this._config.channels.filter((c) => c.receiveNotifications);

    for (const channel of channels) {
      this._validateChannelId(channel.platform, channel.channelId);
    }

    return channels;
  }

  /**
   * Validate a channel ID and log a warning if invalid.
   * Telegram chat IDs should be numeric (positive for private, negative for groups).
   */
  private _validateChannelId(platform: MessagePlatform, channelId: string): boolean {
    if (platform === "telegram") {
      const isValid: boolean = /^-?\d+$/.test(channelId);
      if (!isValid) {
        this._logger.warn("Invalid Telegram channel ID detected (should be numeric)", {
          channelId,
          hint: "Send a message to the bot to auto-register the correct chat ID",
        });
      }
      return isValid;
    }
    return true;
  }

  /**
   * Get the permission level for a channel.
   * Returns "ignore" if channel is not registered.
   */
  public getPermission(platform: string, channelId: string): ChannelPermission {
    const channel = this.getChannel(platform, channelId);
    return channel?.permission ?? "ignore";
  }

  /**
   * Check if a channel exists.
   */
  public hasChannel(platform: string, channelId: string): boolean {
    return this._config.channels.some(
      (c) => c.platform === platform && c.channelId === channelId
    );
  }

  /**
   * Get all registered channels.
   */
  public getAllChannels(): IRegisteredChannel[] {
    return [...this._config.channels];
  }

  //#endregion Public Methods - Queries

  //#region Private Methods

  private async _loadAsync(): Promise<void> {
    try {
      if (existsSync(this._filePath)) {
        const content = await readFile(this._filePath, "utf-8");
        const parsed = yaml.parse(content);

        if (parsed && typeof parsed === "object") {
          this._config = {
            version: parsed.version ?? 1,
            channels: parsed.channels ?? [],
          };

          this._logger.info("Loaded channels from channels.yaml", {
            count: this._config.channels.length,
          });
        }
      }
    } catch (error) {
      const errorDetails: string = extractErrorMessage(error);
      this._logger.error(
        "Failed to parse channels.yaml - configuration is corrupted. Starting fresh. " +
          "Please fix the YAML syntax in your config file.",
        { error: errorDetails },
      );
      this._config = { version: 1, channels: [] };
    }
  }

  private async _saveAsync(): Promise<void> {
    try {
      const dir = dirname(this._filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const content = yaml.stringify(this._config);
      await writeFile(this._filePath, content, "utf-8");
    } catch (error) {
      this._logger.error("Failed to save channels.yaml", {
        error: extractErrorMessage(error),
      });
    }
  }

  //#endregion Private Methods
}

//#endregion ChannelRegistryService
