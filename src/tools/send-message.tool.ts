import { tool } from "ai";
import { sendMessageToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { extractErrorMessage } from "../utils/error.js";
import { CronMessageHistoryService } from "../services/cron-message-history.service.js";
import { IExecutionContext } from "../shared/types/index.js";

export type MessageSender = (message: string) => Promise<string | null>;
export type TaskIdProvider = () => string | null;

export function createSendMessageTool(sender: MessageSender) {
  return tool({
    description:
      "Send a message to the user. Use this to communicate progress, ask clarifying questions, or deliver results.",
    inputSchema: sendMessageToolInputSchema,
    execute: async ({
      message,
    }: {
      message: string;
    }): Promise<{ sent: boolean; messageId: string | null; error?: string }> => {
      try {
        const messageId: string | null = await sender(message);
        return { sent: true, messageId };
      } catch (error: unknown) {
        const errorMessage: string = extractErrorMessage(error);
        return { sent: false, messageId: null, error: errorMessage };
      }
    },
  });
}

export function createSendMessageToolWithHistory(
  sender: MessageSender,
  taskIdProvider: TaskIdProvider,
  context: IExecutionContext,
) {
  return tool({
    description:
      "Send a message to the user. Use this to communicate progress, ask clarifying questions, or deliver results. " +
      "IMPORTANT: Call get_previous_message before this tool. The system enforces this to prevent duplicate messages across crons.",
    inputSchema: sendMessageToolInputSchema,
    execute: async ({
      message,
    }: {
      message: string;
    }): Promise<{ sent: boolean; messageId: string | null; error?: string }> => {
      if (!context.toolCallHistory.includes("get_previous_message")) {
        return { sent: false, messageId: null, error: "You must call get_previous_message first to see what previous messages were sent." };
      }
      try {
        const messageId: string | null = await sender(message);

        context.toolCallHistory.push("send_message");

        const taskId: string | null = taskIdProvider();

        if (taskId && messageId) {
          const historyService: CronMessageHistoryService = CronMessageHistoryService.getInstance();

          await historyService.recordMessageAsync(taskId, message);
        }

        return { sent: true, messageId };
      } catch (error: unknown) {
        const errorMessage: string = extractErrorMessage(error);
        return { sent: false, messageId: null, error: errorMessage };
      }
    },
  });
}
