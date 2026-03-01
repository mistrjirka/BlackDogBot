//#region Channel Types

import type { MessagePlatform } from "./messaging.types.js";

/**
 * Permission levels for channels.
 *
 * - ignore: Bot does not respond to incoming messages
 * - read_only: Bot responds but cannot perform destructive operations
 * - full: Bot has full access to all tools
 */
export type ChannelPermission = "ignore" | "read_only" | "full";

/**
 * A registered communication channel.
 */
export interface IRegisteredChannel {
  /** Platform identifier (telegram, discord, etc.) */
  platform: MessagePlatform;

  /** Unique channel identifier on the platform */
  channelId: string;

  /** Discord guild (server) ID - Discord only */
  guildId?: string;

  /** Permission level for this channel */
  permission: ChannelPermission;

  /** Whether this channel receives cron notifications */
  receiveNotifications: boolean;

  /** ISO timestamp when channel was registered */
  createdAt: string;

  /** ISO timestamp when channel was last updated */
  updatedAt: string;
}

/**
 * Channels configuration file structure.
 */
export interface IChannelsConfig {
  /** Config file version for future migrations */
  version: number;

  /** List of registered channels */
  channels: IRegisteredChannel[];
}

//#endregion Channel Types
