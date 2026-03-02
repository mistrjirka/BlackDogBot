import { tool } from "ai";
import { z } from "zod";
import { CronMessageHistoryService } from "../services/cron-message-history.service.js";

const TOOL_DESCRIPTION: string =
  "Get previous messages sent by this cron task. " +
  "IMPORTANT: You MUST call this tool before send_message to avoid sending duplicate or repetitive messages. " +
  "The history shows recent messages (up to last 3) plus a summary of older ones with timestamps.";

export type TaskIdProvider = () => string | null;

export function createGetPreviousMessageTool(taskIdProvider: TaskIdProvider) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({}),
    execute: async (): Promise<{
      messages: Array<{ messageId: string; content: string; sentAt: string }>;
      summary: string | null;
      summaryGeneratedAt: string | null;
      totalMessageCount: number;
    }> => {
      const taskId: string | null = taskIdProvider();

      if (!taskId) {
        return {
          messages: [],
          summary: null,
          summaryGeneratedAt: null,
          totalMessageCount: 0,
        };
      }

      const historyService: CronMessageHistoryService = CronMessageHistoryService.getInstance();

      return historyService.getHistoryAsync(taskId);
    },
  });
}
