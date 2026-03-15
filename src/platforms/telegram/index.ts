import { Bot } from "grammy";

import type { IPlatform, IPlatformDeps } from "../types.js";
import { registerPlatform } from "../registry.js";
import { TelegramAdapter } from "./adapter.js";
import { TelegramHandler } from "./handler.js";
import { setupTelegramCommands } from "./commands.js";
import type { ITelegramConfig } from "./types.js";

interface ITelegramPlatformState {
  _bot?: Bot;
}

//#region Telegram Platform

export const telegramPlatform: IPlatform<ITelegramConfig> = {
  name: "telegram",
  configKey: "telegram",
  displayName: "Telegram",

  createAdapter(_config: ITelegramConfig, _deps: IPlatformDeps) {
    return null; // Created in initialize
  },

  async initialize(config: ITelegramConfig, deps: IPlatformDeps): Promise<void> {
    const bot = new Bot(config.botToken);

    // Catch all grammY errors
    bot.catch((err): void => {
      const updateId = err.ctx?.update?.update_id;
      deps.logger.error("Telegram bot error", {
        error: err.message,
        updateId,
      });
    });

    // Create and register adapter
    const adapter = new TelegramAdapter(bot);
    deps.messagingService.registerAdapter(adapter);

    // Initialize handler
    const handler = TelegramHandler.getInstance();
    await handler.initializeAsync(config, deps);

    // Set up commands
    setupTelegramCommands(bot);

    // Set up message handler (fire-and-forget).
    // Do NOT await handleMessageAsync — it runs long-running LLM calls and would
    // block grammY's sequential update loop, preventing /cancel from being processed.
    // The handler manages its own try/catch/finally and uses _processing guard per chat.
    bot.on("message:text", (ctx) => {
      handler.handleMessageAsync(ctx).catch((err: unknown): void => {
        deps.logger.error("Unhandled error in Telegram message handler", {
          chatId: String(ctx.chat?.id),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // Start bot
    bot.start({
      onStart: (): void => {
        deps.logger.info("Telegram bot is now receiving updates.");
      },
    });

    // Store bot for cleanup
    (this as ITelegramPlatformState)._bot = bot;

    deps.logger.info("Telegram platform initialized");
  },

  async stop(): Promise<void> {
    const state: ITelegramPlatformState = this as ITelegramPlatformState;
    const bot: Bot | undefined = state._bot;
    if (bot) {
      bot.stop();
      state._bot = undefined;
    }
  },

  isEnabled(config: ITelegramConfig): boolean {
    return !!config?.botToken;
  },
};

// Auto-register
registerPlatform(telegramPlatform);

//#endregion Telegram Platform

// Re-export types and components
export * from "./types.js";
export { TelegramAdapter } from "./adapter.js";
export { TelegramHandler } from "./handler.js";
