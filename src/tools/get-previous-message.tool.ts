import { tool } from "ai";
import { z } from "zod";
import { CronMessageHistoryService } from "../services/cron-message-history.service.js";
import type { IExecutionContext } from "../shared/types/index.js";

const TOOL_DESCRIPTION: string =
  "Get previous messages sent by any cron task in the system. IMPORTANT: You MUST call this tool before send_message to see what other crons have sent and avoid duplicate or repetitive messages. The history shows recent messages (up to last 3) plus a summary of older ones.";

export function createGetPreviousMessageTool(context: IExecutionContext) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({}),
    execute: async (): Promise<{
      messages: Array<{ messageId: string; content: string; sentAt: string }>;
      summary: string | null;
      summaryGeneratedAt: string | null;
      totalMessageCount: number;
    }> => {
      context.toolCallHistory.push("get_previous_message");

      const historyService: CronMessageHistoryService = CronMessageHistoryService.getInstance();

      return historyService.getHistoryAsync();
    },
  });
}
