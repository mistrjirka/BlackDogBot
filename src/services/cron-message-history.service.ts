import { generateTextWithRetryAsync } from "../utils/llm-retry.js";
import { LoggerService } from "./logger.service.js";
import { SchedulerService } from "./scheduler.service.js";
import { AiProviderService } from "./ai-provider.service.js";
import { generateId } from "../utils/id.js";
import type { ICronMessageHistory } from "../shared/types/index.js";

//#region Constants

const MAX_KEEP_MESSAGES: number = 3;
const CONTEXT_THRESHOLD_PERCENTAGE: number = 0.15;
const APPROX_CONTEXT_SIZE_CHARS: number = 128_000 * 4;
const MAX_SUMMARY_CHARS: number = Math.floor(APPROX_CONTEXT_SIZE_CHARS * CONTEXT_THRESHOLD_PERCENTAGE);

//#endregion Constants

//#region Interfaces

export interface ICronHistoryResult {
  messages: ICronMessageHistory[];
  summary: string | null;
  summaryGeneratedAt: string | null;
  totalMessageCount: number;
}

//#endregion Interfaces

//#region CronMessageHistoryService

export class CronMessageHistoryService {
  //#region Data members

  private static _instance: CronMessageHistoryService | null;
  private _logger: LoggerService;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): CronMessageHistoryService {
    if (!CronMessageHistoryService._instance) {
      CronMessageHistoryService._instance = new CronMessageHistoryService();
    }

    return CronMessageHistoryService._instance;
  }

  public async getHistoryAsync(taskId: string): Promise<ICronHistoryResult> {
    const task = await SchedulerService.getInstance().getTaskAsync(taskId);

    if (!task) {
      this._logger.warn("Task not found for history lookup", { taskId });
      return {
        messages: [],
        summary: null,
        summaryGeneratedAt: null,
        totalMessageCount: 0,
      };
    }

    return {
      messages: task.messageHistory ?? [],
      summary: task.messageSummary,
      summaryGeneratedAt: task.summaryGeneratedAt,
      totalMessageCount: (task.messageHistory?.length ?? 0) + (task.messageSummary ? 1 : 0),
    };
  }

  public async recordMessageAsync(taskId: string, content: string): Promise<string> {
    const scheduler = SchedulerService.getInstance();
    const task = await scheduler.getTaskAsync(taskId);

    if (!task) {
      this._logger.warn("Task not found for message recording", { taskId });
      return "";
    }

    const messageId: string = generateId();
    const now: string = new Date().toISOString();

    const newMessage: ICronMessageHistory = {
      messageId,
      content,
      sentAt: now,
    };

    const messageHistory: ICronMessageHistory[] = [...(task.messageHistory ?? []), newMessage];

    await scheduler.updateTaskAsync(taskId, {
      messageHistory,
    });

    this._logger.debug("Recorded cron message", { taskId, messageId });

    const totalChars: number = this._calculateTotalChars(messageHistory, task.messageSummary);

    if (totalChars > MAX_SUMMARY_CHARS) {
      this._logger.info("Message history exceeds threshold, compacting", {
        taskId,
        totalChars,
        threshold: MAX_SUMMARY_CHARS,
      });

      await this._summarizeAndCompactAsync(taskId);
    }

    return messageId;
  }

  //#endregion Public methods

  //#region Private methods

  private _calculateTotalChars(
    messages: ICronMessageHistory[],
    summary: string | null,
  ): number {
    const messagesChars: number = messages.reduce(
      (sum: number, msg: ICronMessageHistory) => sum + msg.content.length,
      0,
    );

    const summaryChars: number = summary?.length ?? 0;

    return messagesChars + summaryChars;
  }

  private async _summarizeAndCompactAsync(taskId: string): Promise<void> {
    const scheduler = SchedulerService.getInstance();
    const task = await scheduler.getTaskAsync(taskId);

    if (!task) {
      this._logger.warn("Task not found for compaction", { taskId });
      return;
    }

    const messageHistory: ICronMessageHistory[] = task.messageHistory ?? [];

    if (messageHistory.length <= MAX_KEEP_MESSAGES) {
      return;
    }

    const messagesToSummarize: ICronMessageHistory[] = messageHistory.slice(0, -MAX_KEEP_MESSAGES);
    const recentMessages: ICronMessageHistory[] = messageHistory.slice(-MAX_KEEP_MESSAGES);

    if (messagesToSummarize.length === 0) {
      return;
    }

    const historyText: string = messagesToSummarize
      .map((msg: ICronMessageHistory) => `[${msg.sentAt}]: ${msg.content}`)
      .join("\n\n");

    const existingSummary: string = task.messageSummary ?? "";

    const prompt: string = existingSummary
      ? `Summarize the following cron message history and existing summary. Focus on key information sent to the user. Be concise but preserve important details. The summary should help the agent avoid sending duplicate or repetitive messages.

Existing summary:
${existingSummary}

New messages to incorporate:
${historyText}

Output a single concise summary paragraph.`
      : `Summarize the following cron message history. Focus on key information sent to the user. Be concise but preserve important details. The summary should help the agent avoid sending duplicate or repetitive messages.

Messages:
${historyText}

Output a single concise summary paragraph.`;

    try {
      const model = AiProviderService.getInstance().getModel();

      const result = await generateTextWithRetryAsync({
        model,
        prompt,
      });

      const newSummary: string = result.text ?? "";
      const now: string = new Date().toISOString();

      await scheduler.updateTaskAsync(taskId, {
        messageHistory: recentMessages,
        messageSummary: newSummary,
        summaryGeneratedAt: now,
      });

      this._logger.info("Compacted cron message history", {
        taskId,
        summarizedCount: messagesToSummarize.length,
        keptCount: recentMessages.length,
        summaryLength: newSummary.length,
      });
    } catch (error: unknown) {
      this._logger.error("Failed to compact message history", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  //#endregion Private methods
}

//#endregion CronMessageHistoryService
