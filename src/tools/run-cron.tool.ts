import { tool } from "langchain";
import { z } from "zod";
import { SchedulerService } from "../services/scheduler.service.js";
import { LangchainCronExecutor, type IToolCallTrace, type ITraceCollector } from "../agent/langchain-cron-executor.js";
import { LoggerService } from "../services/logger.service.js";
import type { IExecutionContext } from "../shared/types/index.js";
import { summarizeJson } from "../utils/json-summarize.js";
import { extractErrorMessage } from "../utils/error.js";
import { generateId } from "../utils/id.js";

//#region Interfaces

interface IRunCronInput {
  taskId: string;
  sendToUser?: boolean;
}

interface ISentMessage {
  text: string;
  timestamp: string;
}

interface IRunCronResult {
  success: boolean;
  markdown: string;
}

//#endregion Interfaces

//#region Trace Collector

class SimpleTraceCollector implements ITraceCollector {
  private _traces: IToolCallTrace[] = [];

  public addTrace(trace: IToolCallTrace): void {
    this._traces.push(trace);
  }

  public getTraces(): IToolCallTrace[] {
    return this._traces;
  }
}

//#endregion Trace Collector

//#region Tool

export const runCronTool = tool(
  async (input: IRunCronInput): Promise<IRunCronResult> => {
    const logger = LoggerService.getInstance();
    const scheduler = SchedulerService.getInstance();
    const cronExecutor = LangchainCronExecutor.getInstance();

    try {
      const task = await scheduler.getTaskAsync(input.taskId);
      if (!task) {
        return {
          success: false,
          markdown: `## Task Not Found\n\nTask with ID \`${input.taskId}\` does not exist.`,
        };
      }

      const traceCollector = new SimpleTraceCollector();
      const sentMessages: ISentMessage[] = [];
      const executionContext: IExecutionContext = {
        toolCallHistory: [],
        taskName: task.name,
        taskDescription: task.description,
        taskInstructions: task.instructions,
      };

      const taskIdProvider = (): string | null => task.taskId;

      let messageSender: (message: string) => Promise<string | null>;

      if (!input.sendToUser) {
        messageSender = async (message: string): Promise<string | null> => {
          sentMessages.push({
            text: message,
            timestamp: new Date().toISOString(),
          });
          return generateId();
        };
      } else {
        const { MessagingService } = await import("../services/messaging.service.js");
        const { ChannelRegistryService } = await import("../services/channel-registry.service.js");

        const messagingService = MessagingService.getInstance();
        const channelRegistry = ChannelRegistryService.getInstance();
        const notificationChannels = channelRegistry.getNotificationChannels();

        messageSender = async (message: string): Promise<string | null> => {
          for (const channel of notificationChannels) {
            try {
              if (!messagingService.hasAdapter(channel.platform)) {
                continue;
              }
              const sender = messagingService.createSenderForChat(channel.platform, channel.channelId);
              await sender(message);
            } catch (sendError) {
              logger.error(`Failed to send message to ${channel.platform}:${channel.channelId}`, {
                error: extractErrorMessage(sendError),
              });
            }
          }
          return generateId();
        };
      }

      const result = await cronExecutor.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        executionContext,
        traceCollector,
      );

      const traces = traceCollector.getTraces();
      const sendMode = input.sendToUser === true;
      const markdown = formatResultMarkdown(
        task.name,
        task.taskId,
        result.text,
        traces,
        sentMessages,
        sendMode,
      );

      return {
        success: true,
        markdown,
      };
    } catch (error: unknown) {
      const errorMessage = extractErrorMessage(error);
      logger.error(`[run-cron] Failed to execute task`, { error: errorMessage });

      return {
        success: false,
        markdown: `## Error\n\nFailed to execute task: ${errorMessage}`,
      };
    }
  },
  {
    name: "run_cron",
    description:
      "Execute a scheduled task immediately. " +
      "**Call ONCE per task** - it runs to completion. " +
      "Returns tool call trace and messages. " +
      "Default: sendToUser=false (dry-run, messages shown in output only). " +
      "Set sendToUser=true to actually send messages to notification channels.",
    schema: z.object({
      taskId: z
        .string()
        .min(1)
        .describe("ID of the scheduled task to run immediately"),
      sendToUser: z
        .preprocess(
          (val) => {
            if (typeof val === "string") {
              return val.toLowerCase() === "true";
            }
            return val;
          },
          z.boolean()
        )
        .optional()
        .default(false)
        .describe("If true, send messages to notification channels. If false (default), only show in output (dry-run)"),
    }),
  },
);

//#endregion Tool

//#region Formatting

const MAX_MESSAGE_PREVIEW = 200;
const MAX_REASONING_PREVIEW = 280;

function truncateTraceInput(trace: IToolCallTrace): Record<string, unknown> {
  const input = trace.input as Record<string, unknown>;

  if (trace.name === "send_message" && typeof input.message === "string") {
    const message = input.message;
    if (message.length > MAX_MESSAGE_PREVIEW) {
      return {
        ...input,
        message: message.slice(0, MAX_MESSAGE_PREVIEW) + "\n\n[TRUNCATED - full message shown in Messages section]",
      };
    }
  }

  return input;
}

function extractReasoningPreview(input: Record<string, unknown>): string | null {
  if (!("reasoning" in input)) {
    return null;
  }

  const reasoningValue: unknown = input.reasoning;

  if (typeof reasoningValue !== "string") {
    return null;
  }

  const trimmedReasoning: string = reasoningValue.trim();

  if (trimmedReasoning.length === 0) {
    return null;
  }

  if (trimmedReasoning.length <= MAX_REASONING_PREVIEW) {
    return trimmedReasoning;
  }

  return trimmedReasoning.slice(0, MAX_REASONING_PREVIEW) + "…";
}

function formatResultMarkdown(
  taskName: string,
  taskId: string,
  finalText: string,
  traces: IToolCallTrace[],
  sentMessages: ISentMessage[],
  sendMode: boolean,
): string {
  const lines: string[] = [];

  lines.push("## ✅ Task Completed");
  lines.push("");
  lines.push(`- **Task:** "${taskName}"`);
  lines.push(`- **Task ID:** \`${taskId}\``);
  if (sendMode) {
    lines.push(`- **Messages:** ${sentMessages.length} sent to notification channels`);
  } else {
    lines.push(`- **Messages:** ${sentMessages.length} (dry-run mode, not sent)`);
  }
  lines.push("");

  lines.push("### Final Result");
  lines.push("");
  lines.push(finalText || "(No final result)");
  lines.push("");

  lines.push("### Tool Call Trace");
  lines.push("");
  lines.push("> **Note:** Tool outputs are shortened for readability.");
  lines.push("");

  if (traces.length === 0) {
    lines.push("_No tool calls were made._");
  } else {
    for (const trace of traces) {
      const truncatedInput = truncateTraceInput(trace);
      const reasoningPreview: string | null = extractReasoningPreview(truncatedInput);
      lines.push(`#### Step ${trace.step}: \`${trace.name}\`${trace.isError ? " **(error)**" : ""}`);
      lines.push("");
      if (reasoningPreview) {
        lines.push("**Reasoning:**");
        lines.push("");
        lines.push(reasoningPreview);
        lines.push("");
      }
      lines.push("**Input:**");
      lines.push("```json");
      lines.push(JSON.stringify(truncatedInput, null, 2));
      lines.push("```");
      lines.push("");
      lines.push("**Output (shortened):**");
      lines.push("```json");
      lines.push(summarizeJson(trace.output));
      lines.push("```");
      lines.push("");
    }
  }

  if (sentMessages.length > 0) {
    lines.push(sendMode ? "### Messages (sent to notification channels)" : "### Messages (captured, not sent)");
    lines.push("");

    for (let i = 0; i < sentMessages.length; i++) {
      const msg = sentMessages[i];
      lines.push(`**Message ${i + 1}:**`);
      lines.push("```");
      lines.push(msg.text);
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n");
}

//#endregion Formatting
