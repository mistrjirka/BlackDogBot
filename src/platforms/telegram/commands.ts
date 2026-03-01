import { Context, Bot } from "grammy";

import { LoggerService } from "../../services/logger.service.js";
import { PromptService } from "../../services/prompt.service.js";
import { MainAgent } from "../../agent/main-agent.js";
import { ChannelRegistryService } from "../../services/channel-registry.service.js";
import { factoryResetAsync, type IFactoryResetResult } from "../../services/factory-reset.service.js";

//#region Telegram Commands

/**
 * Set up Telegram bot commands.
 * Handles /start, /help, /clear, /reset, /factory_reset, /notifications_enable, /notifications_disable, /status
 */
export function setupTelegramCommands(bot: Bot): void {
  const logger = LoggerService.getInstance();
  const channelRegistry = ChannelRegistryService.getInstance();
  const promptService = PromptService.getInstance();
  const mainAgent = MainAgent.getInstance();

  // /start command
  bot.command("start", async (ctx: Context): Promise<void> => {
    await ctx.reply("BetterClaw is ready. Send me a message to get started.");
  });

  // /help command
  bot.command("help", async (ctx: Context): Promise<void> => {
    const helpText: string = [
      "Available commands:",
      "/start — Initialize the bot",
      "/help — Show this help message",
      "/clear — Clear conversation history for this chat",
      "/reset [name|all] — Reset prompt(s) to factory defaults",
      "/factory_reset — Full nuclear reset: delete all jobs, knowledge, tasks, skills, prompts, workspace, logs, and chat history",
      "/notifications_enable — Enable cron notifications for this chat",
      "/notifications_disable — Disable cron notifications for this chat",
      "/status — Show current chat status",
    ].join("\n");

    await ctx.reply(helpText);
  });

  // /clear command
  bot.command("clear", async (ctx: Context): Promise<void> => {
    const chatId: string = String(ctx.chat?.id);

    mainAgent.clearChatHistory(chatId);
    await ctx.reply("Conversation history cleared.");
    logger.info("Chat history cleared via /clear command.", { chatId });
  });

  // /reset command
  bot.command("reset", async (ctx: Context): Promise<void> => {
    const args: string = typeof ctx.match === "string" ? ctx.match : "";

    try {
      if (!args || args === "all") {
        await promptService.resetAllPromptsAsync();
        await ctx.reply("All prompts have been reset to factory defaults.");
        logger.info("All prompts reset via /reset command.");
      } else {
        const promptName: string = args.trim();
        await promptService.resetPromptAsync(promptName);
        await ctx.reply(`Prompt "${promptName}" has been reset to factory default.`);
        logger.info("Prompt reset via /reset command.", { promptName });
      }
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to reset: ${errorMessage}`);
      logger.error("Failed to reset prompt via /reset command.", { error: errorMessage });
    }
  });

  // /factory_reset command
  bot.command("factory_reset", async (ctx: Context): Promise<void> => {
    await ctx.reply(
      "Starting factory reset — this will delete ALL data (jobs, knowledge, tasks, skills state, prompts, workspace, logs, chat history)..."
    );

    try {
      const result: IFactoryResetResult = await factoryResetAsync();

      if (result.success) {
        await ctx.reply("Factory reset complete. All data has been wiped and prompts restored to defaults.");
      } else {
        const errorSummary: string = result.errors.join("\n");
        await ctx.reply(`Factory reset completed with errors:\n${errorSummary}`);
      }
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Factory reset failed: ${errorMessage}`);
      logger.error("Factory reset failed.", { error: errorMessage });
    }
  });

  // /notifications_enable command
  bot.command("notifications_enable", async (ctx: Context): Promise<void> => {
    const chatId = String(ctx.chat?.id);

    if (!chatId) {
      await ctx.reply("Error: Could not determine chat ID.");
      return;
    }

    // Register channel if not exists, or update existing
    await channelRegistry.registerChannelAsync("telegram", chatId, {
      permission: "full",
      receiveNotifications: true,
    });

    await ctx.reply("✅ Notifications *enabled* for this chat. You will receive cron task alerts here.", {
      parse_mode: "Markdown",
    });
    logger.info("Notifications enabled via command", { chatId });
  });

  // /notifications_disable command
  bot.command("notifications_disable", async (ctx: Context): Promise<void> => {
    const chatId = String(ctx.chat?.id);

    if (!chatId) {
      await ctx.reply("Error: Could not determine chat ID.");
      return;
    }

    const success = await channelRegistry.setNotificationsEnabledAsync("telegram", chatId, false);

    if (success) {
      await ctx.reply(
        "🔕 Notifications *disabled* for this chat. You will no longer receive cron task alerts here.",
        { parse_mode: "Markdown" }
      );
      logger.info("Notifications disabled via command", { chatId });
    } else {
      await ctx.reply("This chat is not registered. Notifications were never enabled.");
    }
  });

  // /status command
  bot.command("status", async (ctx: Context): Promise<void> => {
    const chatId = String(ctx.chat?.id);
    const channel = channelRegistry.getChannel("telegram", chatId);

    if (!channel) {
      await ctx.reply(
        "📊 Chat Status\n\n" +
          "This chat is not yet registered.\n" +
          "Send any message to register, or use /notifications_enable"
      );
      return;
    }

    const statusLines = [
      "📊 Chat Status",
      "",
      `Permission: ${channel.permission}`,
      `Notifications: ${channel.receiveNotifications ? "✅ Enabled" : "🔕 Disabled"}`,
      `Registered: ${new Date(channel.createdAt).toLocaleDateString()}`,
    ];

    await ctx.reply(statusLines.join("\n"));
  });
}

//#endregion Telegram Commands
