import { tool } from "ai";
import { z } from "zod";
import { SchedulerService } from "../services/scheduler.service.js";
import { CronAgent, type IToolCallTrace, type ITraceCollector } from "../agent/cron-agent.js";
import { LoggerService } from "../services/logger.service.js";
import { summarizeJson } from "../utils/json-summarize.js";
import { extractErrorMessage } from "../utils/error.js";
import { generateId } from "../utils/id.js";

//#region Interfaces

interface IRunCronInput {
  taskId: string;
  captureMessages?: boolean;
}

interface ICapturedMessage {
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

export const runCronTool = tool({
  description:
    "Execute a scheduled task (cron job) immediately, bypassing its schedule. " +
    "Returns detailed tool call trace with inputs and shortened outputs. " +
    "By default, captures messages instead of sending them (dry-run mode).",
  inputSchema: z.object({
    taskId: z
      .string()
      .min(1)
      .describe("ID of the scheduled task to run immediately"),
    captureMessages: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), capture messages instead of sending them (dry-run mode)"),
  }),
  execute: async (input: IRunCronInput): Promise<IRunCronResult> => {
    const logger = LoggerService.getInstance();
    const scheduler = SchedulerService.getInstance();
    const cronAgent = CronAgent.getInstance();

    try {
      const task = await scheduler.getTaskAsync(input.taskId);
      if (!task) {
        return {
          success: false,
          markdown: `## Task Not Found\n\nTask with ID \`${input.taskId}\` does not exist.`,
        };
      }

      const traceCollector = new SimpleTraceCollector();
      const capturedMessages: ICapturedMessage[] = [];

      const taskIdProvider = (): string | null => task.taskId;

      let messageSender: (message: string) => Promise<string | null>;

      if (input.captureMessages !== false) {
        messageSender = async (message: string): Promise<string | null> => {
          capturedMessages.push({
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

      const result = await cronAgent.executeTaskAsync(
        task,
        messageSender,
        taskIdProvider,
        traceCollector,
      );

      const traces = traceCollector.getTraces();
      const markdown = formatResultMarkdown(task.name, result.text, traces, capturedMessages);

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
});

//#endregion Tool

//#region Formatting

function formatResultMarkdown(
  taskName: string,
  finalText: string,
  traces: IToolCallTrace[],
  capturedMessages: ICapturedMessage[],
): string {
  const lines: string[] = [];

  lines.push(`## Task Executed: "${taskName}"`);
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
      lines.push(`#### Step ${trace.step}: \`${trace.name}\`${trace.isError ? " **(error)**" : ""}`);
      lines.push("");
      lines.push("**Input:**");
      lines.push("```json");
      lines.push(JSON.stringify(trace.input, null, 2));
      lines.push("```");
      lines.push("");
      lines.push("**Output (shortened):**");
      lines.push("```json");
      lines.push(summarizeJson(trace.output));
      lines.push("```");
      lines.push("");
    }
  }

  if (capturedMessages.length > 0) {
    lines.push("### Captured Messages");
    lines.push("");
    lines.push(`> Messages were captured instead of sent (dry-run mode).`);
    lines.push("");

    for (let i = 0; i < capturedMessages.length; i++) {
      const msg = capturedMessages[i];
      const preview = msg.text.length > 200 ? msg.text.slice(0, 200) + "..." : msg.text;
      lines.push(`**Message ${i + 1}:**`);
      lines.push("```");
      lines.push(preview);
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n");
}

//#endregion Formatting
