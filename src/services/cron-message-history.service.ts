import { generateTextWithRetryAsync } from "../utils/llm-retry.js";
import { LoggerService } from "./logger.service.js";
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
  private static _sharedHistory: ICronMessageHistory[] = [];
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

  public async getHistoryAsync(): Promise<ICronHistoryResult> {
    const history: ICronMessageHistory[] = CronMessageHistoryService._sharedHistory.slice(-MAX_KEEP_MESSAGES);

    return {
      messages: history,
      summary: null,
      summaryGeneratedAt: null,
      totalMessageCount: history.length,
    };
  }

  public async recordMessageAsync(taskId: string, content: string): Promise<string> {
    const messageId: string = generateId();
    const now: string = new Date().toISOString();

    const newMessage: ICronMessageHistory = {
      messageId,
      content,
      sentAt: now,
    };

    CronMessageHistoryService._sharedHistory.push(newMessage);

    this._logger.debug("Recorded cron message", { taskId, messageId });

    const totalChars: number = this._calculateTotalChars(CronMessageHistoryService._sharedHistory.slice(-MAX_KEEP_MESSAGES), null);

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
    if (CronMessageHistoryService._sharedHistory.length <= MAX_KEEP_MESSAGES) {
      return;
    }

    const messagesToSummarize: ICronMessageHistory[] = CronMessageHistoryService._sharedHistory.slice(0, -MAX_KEEP_MESSAGES);
    const recentMessages: ICronMessageHistory[] = CronMessageHistoryService._sharedHistory.slice(-MAX_KEEP_MESSAGES);

    if (messagesToSummarize.length === 0) {
      return;
    }

    const historyText: string = messagesToSummarize
      .map((msg: ICronMessageHistory) => `[${msg.sentAt}]: ${msg.content}`)
      .join("\n\n");

    const prompt: string = `Summarize the following cron message history. Focus on key information sent to the user. Be concise but preserve important details. The summary should help the agent avoid sending duplicate or repetitive messages.

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

      CronMessageHistoryService._sharedHistory = recentMessages;

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
