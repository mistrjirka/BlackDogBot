import { ApplicationCommandType, type ChatInputCommandInteraction, type Client, type Message, type TextBasedChannel } from "discord.js";

import { LoggerService } from "../../services/logger.service.js";
import { MessagingService } from "../../services/messaging.service.js";
import { MainAgent } from "../../agent/main-agent.js";
import { ChannelRegistryService } from "../../services/channel-registry.service.js";
import type { IAgentResult } from "../../agent/base-agent.js";
import type { IIncomingMessage } from "../../shared/types/messaging.types.js";
import type { IPlatformDeps } from "../types.js";
import type { IDiscordConfig } from "../../shared/types/discord.types.js";
import { generateId } from "../../utils/id.js";
import {
  extractAiErrorDetails,
  formatAiErrorForUser,
  type IAiErrorDetails,
} from "../../utils/ai-error.js";
import { formatMarkdownForDiscord } from "../../utils/discord-format.js";

//#region DiscordHandler

/**
 * Handles incoming Discord messages.
 *
 * Similar to TelegramHandler but:
 * - Uses Discord.js instead of grammy
 * - No commands (config-only for Discord)
 * - Respects permission levels from config
 */
export class DiscordHandler {
  //#region Data Members

  private static _instance: DiscordHandler | null;
  private _logger: LoggerService;
  private _messagingService: MessagingService;
  private _mainAgent: MainAgent;
  private _channelRegistry: ChannelRegistryService;
  private _processing: Set<string>;
  private _inFlightMessageIdByChannel: Map<string, string>;

  //#endregion Data Members

  //#region Constructor

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._messagingService = MessagingService.getInstance();
    this._mainAgent = MainAgent.getInstance();
    this._channelRegistry = ChannelRegistryService.getInstance();
    this._processing = new Set<string>();
    this._inFlightMessageIdByChannel = new Map<string, string>();
  }

  //#endregion Constructor

  //#region Public Methods

  public static getInstance(): DiscordHandler {
    if (!DiscordHandler._instance) {
      DiscordHandler._instance = new DiscordHandler();
    }
    return DiscordHandler._instance;
  }

  public async initializeAsync(client: Client, config: IDiscordConfig, _deps: IPlatformDeps): Promise<void> {
    // Register all configured channels
    for (const ch of config.channels) {
      await this._channelRegistry.registerChannelAsync("discord", ch.channelId, {
        guildId: ch.guildId,
        permission: ch.permission,
        receiveNotifications: ch.receiveNotifications,
      });
      this._logger.info("Registered Discord channel from config", {
        channelId: ch.channelId,
        guildId: ch.guildId,
        permission: ch.permission,
      });
    }

    // Set up message handler
    client.on("messageCreate", async (message: Message) => {
      await this._handleMessageAsync(message);
    });

    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      if (interaction.commandType !== ApplicationCommandType.ChatInput || interaction.commandName !== "cancel") {
        return;
      }

      await this._handleCancelSlashCommandAsync(interaction);
    });

    this._logger.info("DiscordHandler initialized");
  }

  //#endregion Public Methods

  //#region Private Methods

  private async _handleMessageAsync(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Only handle text messages
    if (!message.content) return;

    const channelId = message.channelId;

    // Check if channel is registered
    const channel = this._channelRegistry.getChannel("discord", channelId);
    if (!channel) {
      this._logger.debug("Message from unregistered Discord channel, ignoring", {
        channelId,
        guildId: message.guildId,
      });
      return;
    }

    // Check permission
    if (channel.permission === "ignore") {
      this._logger.debug("Channel is 'ignore', skipping", { channelId });
      return;
    }

    if (_isCancelCommand(message.content)) {
      await this._handleCancelForChannelAsync(channelId, message);
      return;
    }

    // Prevent concurrent processing
    if (this._processing.has(channelId)) {
      this._logger.debug("Already processing, skipping", { channelId });
      return;
    }

    this._processing.add(channelId);
    this._inFlightMessageIdByChannel.set(channelId, message.id);

    try {
      // Show typing indicator
      if (message.channel.isTextBased() && "sendTyping" in message.channel) {
        (message.channel as any).sendTyping().catch(() => {});
      }

      // Build incoming message
      const incoming: IIncomingMessage = {
        id: generateId(),
        platform: "discord",
        text: message.content,
        userId: channelId,
        userName: message.author.username ?? null,
        timestamp: message.createdTimestamp,
        raw: message,
      };

      this._logger.info("Received Discord message", {
        channelId,
        userName: incoming.userName,
        textLength: incoming.text.length,
      });

      // Create sender for this channel
      const sender = this._messagingService.createSenderForChat("discord", channelId);
      const photoSender = this._messagingService.createPhotoSenderForChat("discord", channelId);

      // Initialize agent for this chat
      await this._mainAgent.initializeForChatAsync(channelId, sender, photoSender, undefined, "discord");

      // Start typing indicator loop
      const typingInterval: ReturnType<typeof setInterval> = setInterval(async () => {
        try {
          await this._messagingService.sendChatActionAsync("discord", channelId, "typing");
        } catch {
          // Silently ignore
        }
      }, 5000);

      try {
        const result: IAgentResult = await this._mainAgent.processMessageForChatAsync(
          channelId,
          incoming.text
        );

        // Send response
        if (result.text) {
          const markdownText: string = formatMarkdownForDiscord(result.text);
          const chunks: string[] = this._splitMessage(markdownText, 2000);
          for (const chunk of chunks) {
            await message.reply(chunk);
          }
        }

        this._logger.info("Discord message processed", {
          channelId,
          stepsCount: result.stepsCount,
          responseLength: result.text.length,
        });
      } finally {
        clearInterval(typingInterval);
      }
    } catch (error: unknown) {
      const errorDetails: IAiErrorDetails = extractAiErrorDetails(error);

      this._logger.error("Error processing Discord message", {
        channelId,
        error: errorDetails.message,
        statusCode: errorDetails.statusCode,
        provider: errorDetails.provider,
        model: errorDetails.model,
      });

      try {
        const userMessage: string = formatAiErrorForUser(errorDetails);
        await message.reply(userMessage);
      } catch (replyError: unknown) {
        this._logger.error("Failed to send error reply", {
          channelId,
          error: replyError instanceof Error ? replyError.message : String(replyError),
        });
      }
    } finally {
      this._processing.delete(channelId);
      this._inFlightMessageIdByChannel.delete(channelId);
    }
  }

  private async _handleCancelSlashCommandAsync(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId: string = interaction.channelId;
    const channel = this._channelRegistry.getChannel("discord", channelId);

    if (!channel || channel.permission === "ignore") {
      await interaction.reply({
        content: "This channel is not registered for BetterClaw.",
        ephemeral: true,
      });
      return;
    }

    const responseText: string = await this._cancelChannelWorkAsync(channelId, interaction.channel as TextBasedChannel | null);
    await interaction.reply({
      content: responseText,
      ephemeral: true,
    });
  }

  private async _handleCancelForChannelAsync(
    channelId: string,
    message: Message,
  ): Promise<void> {
    const responseText: string = await this._cancelChannelWorkAsync(channelId, message.channel);

    await message.reply(responseText);
  }

  private async _cancelChannelWorkAsync(channelId: string, channel: TextBasedChannel | null): Promise<string> {
    const stopped: boolean = this._mainAgent.stopChat(channelId);
    let deletedInFlightPrompt: boolean = false;

    const inFlightMessageId: string | undefined = this._inFlightMessageIdByChannel.get(channelId);
    if (inFlightMessageId !== undefined) {
      deletedInFlightPrompt = await this._tryDeleteDiscordMessageAsync(channelId, inFlightMessageId, channel);
      this._inFlightMessageIdByChannel.delete(channelId);
    }

    if (!stopped && !deletedInFlightPrompt) {
      return "Nothing to cancel.";
    }

    const details: string[] = [];
    if (stopped) {
      details.push("stopped current generation");
    }
    if (deletedInFlightPrompt) {
      details.push("deleted in-flight prompt message");
    }

    return `Cancelled: ${details.join(", ")}.`;
  }

  private async _tryDeleteDiscordMessageAsync(
    channelId: string,
    messageId: string,
    channel: TextBasedChannel | null,
  ): Promise<boolean> {
    if (!channel || !("messages" in channel)) {
      return false;
    }

    try {
      const toDelete = await channel.messages.fetch(messageId).catch(() => null);
      if (!toDelete) {
        return false;
      }

      await toDelete.delete();
      return true;
    } catch (error: unknown) {
      this._logger.warn("Failed to delete Discord message during /cancel", {
        channelId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private _splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      let splitIndex = maxLength;

      const lastNewline = remaining.lastIndexOf("\n", maxLength);
      const lastSpace = remaining.lastIndexOf(" ", maxLength);

      if (lastNewline > maxLength * 0.5) {
        splitIndex = lastNewline + 1;
      } else if (lastSpace > maxLength * 0.5) {
        splitIndex = lastSpace + 1;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex);
    }

    return chunks;
  }

  //#endregion Private Methods
}

function _isCancelCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/cancel";
}

//#endregion DiscordHandler
