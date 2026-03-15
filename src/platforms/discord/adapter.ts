import { Client, TextChannel, AttachmentBuilder } from "discord.js";

import type { IPlatformAdapter } from "../../services/messaging.service.js";
import type {
  IOutgoingMessage,
  IOutgoingPhoto,
  MessagePlatform,
} from "../../shared/types/messaging.types.js";
import { formatMarkdownForDiscord } from "../../utils/discord-format.js";
import { splitMessageByLength } from "../../utils/message-split.js";

//#region DiscordAdapter

/**
 * Adapter for sending messages via Discord.
 * Implements IPlatformAdapter for use with MessagingService.
 */
export class DiscordAdapter implements IPlatformAdapter {
  //#region Data Members

  public readonly platform: MessagePlatform;
  private _client: Client;

  //#endregion Data Members

  //#region Constructor

  constructor(client: Client) {
    this.platform = "discord";
    this._client = client;
  }

  //#endregion Constructor

  //#region Public Methods

  public async sendMessageAsync(message: IOutgoingMessage): Promise<string | null> {
    try {
      const channel = await this._client.channels.fetch(message.userId);

      if (!channel || !channel.isTextBased()) {
        return null;
      }

      const markdownText: string = formatMarkdownForDiscord(message.text);
      const chunks: string[] = splitMessageByLength(markdownText, 2000);
      let lastMessageId: string | null = null;

      for (const chunk of chunks) {
        const sent = await (channel as TextChannel).send(chunk);
        lastMessageId = sent.id;
      }

      return lastMessageId;
    } catch (error) {
      console.error("Discord send error:", error);
      return null;
    }
  }

  public async sendPhotoAsync(photo: IOutgoingPhoto): Promise<string | null> {
    try {
      const channel = await this._client.channels.fetch(photo.userId);

      if (!channel || !channel.isTextBased()) {
        return null;
      }

      const attachment = new AttachmentBuilder(photo.imageBuffer, { name: "image.png" });

      const sent = await (channel as TextChannel).send({
        content: photo.caption ?? undefined,
        files: [attachment],
      });

      return sent.id;
    } catch (error) {
      console.error("Discord photo send error:", error);
      return null;
    }
  }

  public async sendChatActionAsync(userId: string, action: string): Promise<void> {
    try {
      const channel = await this._client.channels.fetch(userId);

      if (!channel || !channel.isTextBased()) {
        return;
      }

      // Discord uses "typing" for the typing indicator
      if (action === "typing") {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // Ignore errors for chat actions
    }
  }

  //#endregion Public Methods

}

//#endregion DiscordAdapter
