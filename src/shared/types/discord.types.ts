import type { ChannelPermission } from "./channel.types.js";

//#region Discord Types

export interface IDiscordChannelConfig {
  /** Discord channel ID (snowflake) */
  channelId: string;

  /** Discord guild (server) ID */
  guildId: string;

  /** Permission level for this channel */
  permission: ChannelPermission;

  /** Whether this channel receives cron notifications */
  receiveNotifications: boolean;
}

export interface IDiscordConfig {
  /** Discord bot token */
  botToken: string;

  /** Pre-configured channels from config.yaml */
  channels: IDiscordChannelConfig[];
}

//#endregion Discord Types
