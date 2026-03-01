//#region Telegram Types

export interface ITelegramConfig {
  /** Telegram bot token from @BotFather */
  botToken: string;

  /** List of allowed user IDs (optional - if empty, first user is auto-allowed) */
  allowedUsers?: string[];
}

//#endregion Telegram Types
