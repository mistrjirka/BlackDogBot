import { tool } from "ai";
import { z } from "zod";
import { CronMessageHistoryService } from "../services/cron-message-history.service.js";
import { LoggerService } from "../services/logger.service.js";
import type { IExecutionContext } from "../shared/types/index.js";

const TOOL_DESCRIPTION: string =
  "Get previously sent messages ranked by similarity to your proposed message. " +
  "Use this to inspect what other crons have sent and avoid duplicate or repetitive messages. " +
  "Pass the message you intend to send as the `message` parameter — the tool finds the most similar past messages using embedding similarity search.";

function buildPreview(message: string, maxLength: number = 120): string {
  const normalized: string = message.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

export function createGetPreviousMessageTool(context: IExecutionContext) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({
      message: z.string().describe("The message you plan to send to the user."),
    }),
    execute: async ({
      message,
    }: {
      message: string;
    }): Promise<{
      similarMessages: Array<{ content: string; sentAt: string; score: number; taskId: string }>;
      message: string;
    }> => {
      const logger: LoggerService = LoggerService.getInstance();
      const historyService: CronMessageHistoryService = CronMessageHistoryService.getInstance();

      logger.info("Running get_previous_message tool", {
        messageLength: message.length,
        messagePreview: buildPreview(message),
      });

      const similarMessages = await historyService.getSimilarMessagesAsync(message);

      logger.info("get_previous_message tool completed", {
        similarCount: similarMessages.length,
      });

      context.toolCallHistory.push("get_previous_message");

      return {
        similarMessages,
        message: "Consider whether sending this message is necessary given these previously sent messages.",
      };
    },
  });
}
