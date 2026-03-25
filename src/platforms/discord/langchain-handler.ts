import { type Message } from "discord.js";

import { LoggerService } from "../../services/logger.service.js";
import { invokeAgentAsync } from "../../agent/langchain-agent.js";
import type { IChatImageAttachment } from "../../agent/main-agent.js";

export type LangchainAgent = ReturnType<typeof import("../../agent/langchain-agent.js").createLangchainAgent>;

export type SendMessageFunc = (text: string) => Promise<void>;

export class LangchainDiscordHandler {
  private _agent: LangchainAgent;
  private _logger: LoggerService;
  private _sendMessage: SendMessageFunc;

  constructor(agent: LangchainAgent, logger: LoggerService, sendMessage: SendMessageFunc) {
    this._agent = agent;
    this._logger = logger;
    this._sendMessage = sendMessage;
  }

  public async handleMessageAsync(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (!message.content) {
      return;
    }

    const channelId: string = message.channelId;

    this._logger.info("Langchain Discord handler received message", {
      channelId,
      textLength: message.content.length,
    });

    try {
      const images: IChatImageAttachment[] | undefined = await this._extractImagesAsync(message);

      const result = await invokeAgentAsync(this._agent, message.content, channelId, images);

      if (result.text) {
        await this._sendMessage(result.text);
      }

      this._logger.info("Langchain Discord message processed", {
        channelId,
        stepsCount: result.stepsCount,
        responseLength: result.text.length,
      });
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);

      this._logger.error("Error processing Langchain Discord message", {
        channelId,
        error: errorMessage,
      });

      try {
        await this._sendMessage(`Error: ${errorMessage}`);
      } catch {
        // Ignore send failures
      }
    }
  }

  private async _extractImagesAsync(message: Message): Promise<IChatImageAttachment[]> {
    const images: IChatImageAttachment[] = [];

    if (!message.attachments || message.attachments.size === 0) {
      return images;
    }

    for (const attachment of message.attachments.values()) {
      const contentType: string = attachment.contentType ?? "";
      if (!contentType.startsWith("image/")) {
        continue;
      }

      try {
        const response: Response = await fetch(attachment.url);
        if (!response.ok) {
          this._logger.warn("Failed to fetch Discord attachment image", {
            channelId: message.channelId,
            attachmentId: attachment.id,
            status: response.status,
          });
          continue;
        }

        const arrayBuffer: ArrayBuffer = await response.arrayBuffer();
        const imageBuffer: Buffer = Buffer.from(arrayBuffer);

        images.push({
          imageBuffer,
          mediaType: contentType,
        });
      } catch (error: unknown) {
        this._logger.warn("Error downloading Discord attachment image", {
          channelId: message.channelId,
          attachmentId: attachment.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return images;
  }
}
