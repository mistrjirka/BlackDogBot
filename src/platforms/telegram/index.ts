import { Bot } from "grammy";

import type { IPlatform, IPlatformDeps } from "../types.js";
import { registerPlatform } from "../registry.js";
import { TelegramAdapter } from "./adapter.js";
import { TelegramHandler } from "./handler.js";
import { setupTelegramCommands } from "./commands.js";
import type { ITelegramConfig } from "./types.js";

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

    // Set up message handler
    bot.on("message:text", async (ctx) => {
      await handler.handleMessageAsync(ctx);
    });

    // Start bot
    bot.start({
      onStart: (): void => {
        deps.logger.info("Telegram bot is now receiving updates.");
      },
    });

    // Store bot for cleanup
    (this as any)._bot = bot;

    deps.logger.info("Telegram platform initialized");
  },

  async stop(): Promise<void> {
    const bot = (this as any)._bot;
    if (bot) {
      bot.stop();
      (this as any)._bot = undefined;
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
