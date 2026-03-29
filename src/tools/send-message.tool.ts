import { tool } from "langchain";
import { sendMessageToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { extractErrorMessage } from "../utils/error.js";
import { CronMessageHistoryService } from "../services/cron-message-history.service.js";
import { IExecutionContext } from "../shared/types/index.js";

export type MessageSender = (message: string) => Promise<string | null>;
export type TaskIdProvider = () => string | null;

export function createSendMessageTool(sender: MessageSender) {
  return tool(
    async ({
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
    {
      name: "send_message",
      description:
        "Send a message to the user. Use this to communicate progress, ask clarifying questions, or deliver results.",
      schema: sendMessageToolInputSchema,
    },
  );
}

export function createSendMessageToolWithHistory(
  sender: MessageSender,
  taskIdProvider: TaskIdProvider,
  context: IExecutionContext,
) {
  return tool(
    async ({
      message,
    }: {
      message: string;
    }): Promise<{ sent: boolean; messageId: string | null; error?: string }> => {
      try {
        const taskId: string | null = taskIdProvider();
        const historyService: CronMessageHistoryService = CronMessageHistoryService.getInstance();

        try {
          const dispatchPolicy = await historyService.checkMessageDispatchPolicyAsync(
            message,
            context.taskInstructions,
            context.taskName,
            context.taskDescription,
          );

          if (!dispatchPolicy.shouldDispatch) {
            context.toolCallHistory.push("send_message");
            return { sent: true, messageId: null };
          }

          if (taskId) {
            const novelty = await historyService.checkMessageNoveltyAsync(
              taskId,
              message,
              context.taskInstructions,
              context.taskName,
              context.taskDescription,
            );

            if (!novelty.isNewInformation) {
              context.toolCallHistory.push("send_message");

              return { sent: true, messageId: null };
            }
          }
        } catch {
          // If novelty/policy checks fail, still attempt send_message.
          // Failing closed here can create retry loops in cron agents.
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
    {
      name: "send_message",
      description:
        "Send a message to the user. Use this to communicate progress, ask clarifying questions, or deliver results. " +
        "This tool performs automatic deduplication against previous cron messages and silently skips sending when the message does not add new information.",
      schema: sendMessageToolInputSchema,
    },
  );
}
