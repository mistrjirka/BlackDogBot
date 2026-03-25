import { Bot, Context } from "grammy";

import { LoggerService } from "../../services/logger.service.js";
import { MessagingService } from "../../services/messaging.service.js";
import { invokeAgentAsync } from "../../agent/langchain-agent.js";
import type { IChatImageAttachment } from "../../agent/main-agent.js";
import { splitTelegramMessage } from "../../utils/telegram-message.js";
import { markdownToTelegramHtml, stripAllHtml } from "../../utils/telegram-format.js";
import { extractErrorMessage } from "../../utils/error.js";

export type LangchainAgent = ReturnType<typeof import("../../agent/langchain-agent.js").createLangchainAgent>;

export class LangchainTelegramHandler {
  private _bot: Bot;
  private _agent: LangchainAgent;
  private _messagingService: MessagingService;
  private _logger: LoggerService;

  constructor(bot: Bot, agent: LangchainAgent, messagingService: MessagingService, logger: LoggerService) {
    this._bot = bot;
    this._agent = agent;
    this._messagingService = messagingService;
    this._logger = logger;
  }

  public async handleMessageAsync(ctx: Context): Promise<void> {
    const message = ctx.message;

    if (!message || !message.text) {
      return;
    }

    const chatId: string = String(message.chat.id);

    this._logger.info("Langchain Telegram handler received message", {
      chatId,
      textLength: message.text.length,
    });

    const typingInterval: ReturnType<typeof setInterval> = setInterval(async () => {
      try {
        await this._messagingService.sendChatActionAsync("telegram", chatId, "typing");
      } catch {
        // Silently ignore typing indicator failures
      }
    }, 5000);

    try {
      await this._messagingService.sendChatActionAsync("telegram", chatId, "typing").catch(() => {});

      const images: IChatImageAttachment[] | undefined = await this._extractImagesAsync(ctx);

      const result = await invokeAgentAsync(this._agent, message.text, chatId, images);

      if (result.text) {
        const htmlText: string = markdownToTelegramHtml(result.text);
        const chunks: string[] = splitTelegramMessage(htmlText);

        for (let i: number = 0; i < chunks.length; i++) {
          const options: Record<string, unknown> = {
            parse_mode: "HTML",
          };
          if (i === 0) {
            options.reply_parameters = { message_id: message.message_id };
          }

          try {
            await ctx.reply(chunks[i], options);
          } catch (replyError: unknown) {
            const errorMsg: string = extractErrorMessage(replyError);

            if (errorMsg.includes("message to be replied not found") && options.reply_parameters) {
              delete options.reply_parameters;
              try {
                await ctx.reply(chunks[i], options);
              } catch {
                const plainText: string = stripAllHtml(chunks[i]);
                await ctx.reply(plainText).catch(() => {});
              }
            } else {
              this._logger.warn("Telegram HTML parse error, falling back to plain text", {
                error: errorMsg,
              });
              const plainText: string = stripAllHtml(chunks[i]);
              const fallbackOptions: Record<string, unknown> =
                i === 0 ? { reply_parameters: { message_id: message.message_id } } : {};
              try {
                await ctx.reply("⚠️ Formatting error, showing plain text:", fallbackOptions);
                await ctx.reply(plainText, fallbackOptions);
              } catch {
                await ctx.reply("⚠️ Formatting error, showing plain text:").catch(() => {});
                await ctx.reply(plainText).catch(() => {});
              }
            }
          }
        }
      }

      this._logger.info("Langchain Telegram message processed", {
        chatId,
        stepsCount: result.stepsCount,
        responseLength: result.text.length,
      });
    } catch (error: unknown) {
      this._logger.error("Error processing Langchain Telegram message", {
        chatId,
        error: extractErrorMessage(error),
      });

      try {
        await ctx.reply(`Error: ${extractErrorMessage(error)}`);
      } catch {
        // Ignore
      }
    } finally {
      clearInterval(typingInterval);
    }
  }

  private async _extractImagesAsync(ctx: Context): Promise<IChatImageAttachment[]> {
    const message = ctx.message;
    if (!message) {
      return [];
    }

    const images: IChatImageAttachment[] = [];

    if ("photo" in message && Array.isArray(message.photo) && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1];
      const file = await ctx.api.getFile(largestPhoto.file_id);
      if (file.file_path) {
        const imageBuffer: Buffer = await this._downloadFileAsync(file.file_path);
        images.push({
          imageBuffer,
          mediaType: "image/jpeg",
        });
      }
    } else if ("document" in message && message.document) {
      const doc = message.document;
      const mimeType: string = doc.mime_type ?? "";
      if (mimeType.startsWith("image/")) {
        const file = await ctx.api.getFile(doc.file_id);
        if (file.file_path) {
          const imageBuffer: Buffer = await this._downloadFileAsync(file.file_path);
          images.push({
            imageBuffer,
            mediaType: mimeType,
          });
        }
      }
    }

    return images;
  }

  private async _downloadFileAsync(filePath: string): Promise<Buffer> {
    const config = (this._bot as any).token;
    const url: string = `https://api.telegram.org/file/bot${config}/${filePath}`;
    const response: Response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file (${response.status} ${response.statusText}).`);
    }
    const arrayBuffer: ArrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
