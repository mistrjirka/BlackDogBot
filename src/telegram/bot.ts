import { Bot } from "grammy";

import { LoggerService } from "../services/logger.service.js";
import { PromptService } from "../services/prompt.service.js";
import { factoryResetAsync, type IFactoryResetResult } from "../services/factory-reset.service.js";
import { MessagingService, TelegramAdapter } from "../services/messaging.service.js";
import { MainAgent } from "../agent/main-agent.js";
import { TelegramHandler } from "./handler.js";

//#region TelegramBot

export class TelegramBot {
  //#region Data members

  private static _instance: TelegramBot | null;
  private _bot: Bot | null;
  private _logger: LoggerService;
  private _running: boolean;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._bot = null;
    this._logger = LoggerService.getInstance();
    this._running = false;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): TelegramBot {
    if (!TelegramBot._instance) {
      TelegramBot._instance = new TelegramBot();
    }

    return TelegramBot._instance;
  }

  public async initializeAsync(botToken: string): Promise<void> {
    this._bot = new Bot(botToken);

    // Catch all grammY errors
    this._bot.catch((err): void => {
      const updateId = err.ctx?.update?.update_id;
      this._logger.error("Telegram bot error", {
        error: err.message,
        updateId,
      });
    });

    // Register the Telegram adapter with the MessagingService
    const adapter: TelegramAdapter = new TelegramAdapter(this._bot);
    const messagingService: MessagingService = MessagingService.getInstance();

    messagingService.registerAdapter(adapter);

    this._registerCommands();
    this._registerMessageHandler();

    this._logger.info("TelegramBot initialized.");
  }

  public async startAsync(): Promise<void> {
    if (!this._bot) {
      throw new Error("TelegramBot not initialized. Call initializeAsync() first.");
    }

    if (this._running) {
      this._logger.warn("TelegramBot is already running.");
      return;
    }

    this._running = true;

    this._logger.info("Starting Telegram bot with long polling...");

    this._bot.start({
      onStart: (): void => {
        this._logger.info("Telegram bot is now receiving updates.");
      },
    });
  }

  public async stopAsync(): Promise<void> {
    if (!this._bot || !this._running) {
      return;
    }

    this._logger.info("Stopping Telegram bot...");

    await this._bot.stop();
    this._running = false;

    this._logger.info("Telegram bot stopped.");
  }

  //#endregion Public methods

  //#region Private methods

  private _registerCommands(): void {
    if (!this._bot) {
      return;
    }

    // /reset command — handled at messaging layer, not by the agent
    this._bot.command("reset", async (ctx): Promise<void> => {
      const args: string = ctx.match;
      const promptService: PromptService = PromptService.getInstance();

      try {
        if (!args || args === "all") {
          await promptService.resetAllPromptsAsync();
          await ctx.reply("All prompts have been reset to factory defaults.");
          this._logger.info("All prompts reset via /reset command.");
        } else {
          const promptName: string = args.trim();

          await promptService.resetPromptAsync(promptName);
          await ctx.reply(`Prompt "${promptName}" has been reset to factory default.`);
          this._logger.info("Prompt reset via /reset command.", { promptName });
        }
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        await ctx.reply(`Failed to reset: ${errorMessage}`);
        this._logger.error("Failed to reset prompt via /reset command.", { error: errorMessage });
      }
    });

    // /start command
    this._bot.command("start", async (ctx): Promise<void> => {
      await ctx.reply("BetterClaw is ready. Send me a message to get started.");
    });

    // /clear command — clears conversation history for this chat
    this._bot.command("clear", async (ctx): Promise<void> => {
      const chatId: string = String(ctx.chat.id);
      const mainAgent: MainAgent = MainAgent.getInstance();

      mainAgent.clearChatHistory(chatId);
      await ctx.reply("Conversation history cleared.");
      this._logger.info("Chat history cleared via /clear command.", { chatId });
    });

    // /factory_reset command — full nuclear reset to factory defaults
    this._bot.command("factory_reset", async (ctx): Promise<void> => {
      await ctx.reply("Starting factory reset — this will delete ALL data (jobs, knowledge, tasks, skills state, prompts, workspace, logs, chat history)...");

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
        this._logger.error("Factory reset failed.", { error: errorMessage });
      }
    });

    // /help command — lists available commands
    this._bot.command("help", async (ctx): Promise<void> => {
      const helpText: string = [
        "Available commands:",
        "/start — Initialize the bot",
        "/help — Show this help message",
        "/clear — Clear conversation history for this chat",
        "/reset [name|all] — Reset prompt(s) to factory defaults",
        "/factory_reset — Full nuclear reset: delete all jobs, knowledge, tasks, skills, prompts, workspace, logs, and chat history",
      ].join("\n");

      await ctx.reply(helpText);
    });
  }

  private _registerMessageHandler(): void {
    if (!this._bot) {
      return;
    }

    const handler: TelegramHandler = TelegramHandler.getInstance();

    this._bot.on("message:text", async (ctx): Promise<void> => {
      await handler.handleMessageAsync(ctx);
    });
  }

  //#endregion Private methods
}

//#endregion TelegramBot
