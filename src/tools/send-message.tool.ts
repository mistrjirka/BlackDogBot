import { tool } from "ai";
import { sendMessageToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { extractErrorMessage } from "../utils/error.js";
import { CronMessageHistoryService } from "../services/cron-message-history.service.js";
import { IExecutionContext } from "../shared/types/index.js";

export type MessageSender = (message: string) => Promise<string | null>;
export type TaskIdProvider = () => string | null;

interface ISendMessageResult {
  sent: boolean;
  messageId: string | null;
  error?: string;
  suppressedReason?: string;
  suppressedAt?: string;
}

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
      "This tool performs automatic deduplication against previous cron messages and silently skips sending when the message does not add new information.",
    inputSchema: sendMessageToolInputSchema,
    execute: async ({
      message,
    }: {
      message: string;
    }): Promise<ISendMessageResult> => {
      const suppressedAt: string = new Date().toISOString();

      try {
        const taskId: string | null = taskIdProvider();
        const historyService: CronMessageHistoryService = CronMessageHistoryService.getInstance();

        const dispatchPolicy = await historyService.checkMessageDispatchPolicyAsync(
          message,
          context.taskInstructions,
          context.taskName,
          context.taskDescription,
        );

        if (!dispatchPolicy.shouldDispatch) {
          context.toolCallHistory.push("send_message");
          return { sent: false, messageId: null, suppressedReason: "policy", suppressedAt };
        }

        const messageDedupEnabled: boolean = context.messageDedupEnabled !== false;

        if (taskId && messageDedupEnabled) {
          const novelty = await historyService.checkMessageNoveltyAsync(
            taskId,
            message,
            context.taskInstructions,
            context.taskName,
            context.taskDescription,
          );

          if (!novelty.isNewInformation) {
            context.toolCallHistory.push("send_message");

            return { sent: false, messageId: null, suppressedReason: "duplicate", suppressedAt };
          }
        }

        const messageId: string | null = await sender(message);

        context.toolCallHistory.push("send_message");

        if (taskId && messageId) {
          await historyService.recordMessageAsync(taskId, message);
          historyService.recordToVectorStoreAsync(taskId, message).catch(() => {
            // Fire-and-forget — vector store recording failure should not block the send
          });
        }

        return { sent: true, messageId };
      } catch (error: unknown) {
        const errorMessage: string = extractErrorMessage(error);
        return { sent: false, messageId: null, error: errorMessage };
      }
    },
  });
}
