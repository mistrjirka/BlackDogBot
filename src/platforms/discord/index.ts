import { Client, GatewayIntentBits } from "discord.js";

import type { IPlatform, IPlatformDeps } from "../types.js";
import { registerPlatform } from "../registry.js";
import { DiscordAdapter } from "./adapter.js";
import { DiscordHandler } from "./handler.js";
import type { IDiscordConfig } from "../../shared/types/discord.types.js";

interface IDiscordPlatformState {
  _client?: Client;
}

//#region Discord Platform

export const discordPlatform: IPlatform<IDiscordConfig> = {
  name: "discord",
  configKey: "discord",
  displayName: "Discord",

  createAdapter(_config: IDiscordConfig, _deps: IPlatformDeps) {
    return null; // Created in initialize
  },

  async initialize(config: IDiscordConfig, deps: IPlatformDeps): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Create and register adapter
    const adapter = new DiscordAdapter(client);
    deps.messagingService.registerAdapter(adapter);

    // Initialize handler
    const handler = DiscordHandler.getInstance();

    // Wait for client to be ready
    await new Promise<void>((resolve) => {
      client.once("ready", () => {
        deps.logger.info("Discord client ready", {
          user: client.user?.tag,
          guilds: client.guilds.cache.size,
        });
        resolve();
      });
      client.login(config.botToken);
    });

    await client.application?.commands.create({
      name: "cancel",
      description: "Stop current generation and delete the active prompt.",
    }).catch((error: unknown) => {
      deps.logger.warn("Failed to register Discord /cancel command", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Initialize handler after client is ready
    await handler.initializeAsync(client, config, deps);

    // Store client for cleanup
    (this as IDiscordPlatformState)._client = client;

    deps.logger.info("Discord platform initialized");

    // Log important note about privileged intent
    deps.logger.info(
      "NOTE: Discord MessageContent intent must be enabled in Discord Developer Portal (Bot > Privileged Gateway Intents)"
    );
  },

  async stop(): Promise<void> {
    const state: IDiscordPlatformState = this as IDiscordPlatformState;
    const client: Client | undefined = state._client;
    if (client) {
      await client.destroy();
      state._client = undefined;
    }
  },

  isEnabled(config: IDiscordConfig): boolean {
    return !!config?.botToken;
  },
};

// Auto-register
registerPlatform(discordPlatform);

//#endregion Discord Platform

// Re-export
export { DiscordAdapter } from "./adapter.js";
export { DiscordHandler } from "./handler.js";
