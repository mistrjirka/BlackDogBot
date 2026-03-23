import { generateTextWithRetryAsync } from "../utils/llm-retry.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { LoggerService } from "./logger.service.js";
import { AiProviderService } from "./ai-provider.service.js";
import { EmbeddingService } from "./embedding.service.js";
import { VectorStoreService } from "./vector-store.service.js";
import { generateId } from "../utils/id.js";
import type { ICronMessageHistory } from "../shared/types/index.js";
import { z } from "zod";

//#region Constants

const MAX_KEEP_MESSAGES: number = 3;
const CONTEXT_THRESHOLD_PERCENTAGE: number = 0.15;
const APPROX_CONTEXT_SIZE_CHARS: number = 128_000 * 4;
const MAX_SUMMARY_CHARS: number = Math.floor(APPROX_CONTEXT_SIZE_CHARS * CONTEXT_THRESHOLD_PERCENTAGE);
const VECTOR_TABLE_NAME: string = "cron-messages";
const SIMILARITY_SEARCH_LIMIT: number = 10;
const SEARCH_LOG_PREVIEW_LENGTH: number = 120;

const MessageNoveltySchema = z.object({
  isNewInformation: z.boolean(),
});

//#endregion Constants

//#region Interfaces

export interface ICronHistoryResult {
  messages: ICronMessageHistory[];
  summary: string | null;
  summaryGeneratedAt: string | null;
  totalMessageCount: number;
}

export interface ISimilarMessage {
  content: string;
  sentAt: string;
  score: number;
  taskId: string;
}

export interface ICheckMessageNoveltyResult {
  isNewInformation: boolean;
  similarCount: number;
}

interface ISearchResultMetadata {
  sentAt?: string;
  taskId?: string;
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

  public async recordToVectorStoreAsync(taskId: string, content: string): Promise<void> {
    try {
      const embeddingService: EmbeddingService = EmbeddingService.getInstance();
      const vectorStore: VectorStoreService = VectorStoreService.getInstance();

      const embedding: number[] = await embeddingService.embedAsync(content);
      const now: string = new Date().toISOString();

      await vectorStore.addAsync(
        [
          {
            id: generateId(),
            content,
            collection: taskId,
            vector: embedding,
            metadata: JSON.stringify({ sentAt: now, taskId }),
            createdAt: now,
            updatedAt: now,
          },
        ],
        VECTOR_TABLE_NAME,
      );

      this._logger.debug("Recorded cron message to vector store", { taskId });
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      this._logger.warn("Failed to record cron message to vector store, continuing without vector dedup.", { taskId, error: message });
    }
  }

  public async getSimilarMessagesAsync(message: string): Promise<ISimilarMessage[]> {
    const embeddingService: EmbeddingService = EmbeddingService.getInstance();

    if (!embeddingService.isInitialized()) {
      throw new Error(
        "Embeddings not configured. Cron message dedup requires an embedding provider. " +
          "Set 'embeddingProvider' in config (e.g. 'local' or 'openrouter').",
      );
    }

    const vectorStore: VectorStoreService = VectorStoreService.getInstance();

    if (!vectorStore.isInitialized()) {
      throw new Error(
        "Vector store not initialized. Cron message dedup requires the vector store to be initialized.",
      );
    }

    const embedding: number[] = await embeddingService.embedAsync(message);
    const results = await vectorStore.searchAsync(embedding, SIMILARITY_SEARCH_LIMIT, undefined, VECTOR_TABLE_NAME);
    const similarMessages: ISimilarMessage[] = results.map((result) => {
      const metadata: ISearchResultMetadata = this._parseSearchMetadata(result.metadata);

      return {
        content: result.content,
        sentAt: metadata.sentAt ?? "",
        score: result.score,
        taskId: metadata.taskId ?? result.collection,
      };
    });

    this._logger.info("Cron similar message search completed", {
      queryLength: message.length,
      queryPreview: this._buildSearchPreview(message),
      resultCount: similarMessages.length,
      results: similarMessages.map((item: ISimilarMessage, index: number) => ({
        rank: index + 1,
        score: Number(item.score.toFixed(4)),
        taskId: item.taskId,
        sentAt: item.sentAt,
        preview: this._buildSearchPreview(item.content),
      })),
    });

    return similarMessages;
  }

  public async checkMessageNoveltyAsync(taskId: string, message: string): Promise<ICheckMessageNoveltyResult> {
    try {
      const similarMessages: ISimilarMessage[] = await this.getSimilarMessagesAsync(message);

      if (similarMessages.length === 0) {
        return {
          isNewInformation: true,
          similarCount: 0,
        };
      }

      const model = AiProviderService.getInstance().getModel();
      const candidateMessage: string = message.trim();
      const similarMessagesBlock: string = similarMessages
        .map((item: ISimilarMessage, index: number): string => {
          const score: number = Number(item.score.toFixed(4));
          return [
            `#${index + 1}`,
            `score: ${score}`,
            `taskId: ${item.taskId}`,
            `sentAt: ${item.sentAt || "unknown"}`,
            `content: ${item.content}`,
          ].join("\n");
        })
        .join("\n\n");

      const noveltyPrompt: string = `You are a strict deduplication checker for cron notifications.

Decide whether the candidate message introduces materially new information compared to previous similar messages.

Return isNewInformation=true only when the candidate contains at least one meaningful new fact, update, result, or actionable detail that is not already conveyed by the previous messages.

Return isNewInformation=false when the candidate is a duplicate or near-duplicate of prior messages, including paraphrases, wording/style changes, reordered wording, or cosmetic formatting differences.

Candidate message:
${candidateMessage}

Top similar previous messages:
${similarMessagesBlock}`;

      const decision = await generateObjectWithRetryAsync({
        model,
        schema: MessageNoveltySchema,
        prompt: noveltyPrompt,
        retryOptions: {
          callType: "schema_extraction",
        },
      });

      this._logger.info("Cron message novelty decision computed", {
        taskId,
        isNewInformation: decision.object.isNewInformation,
        similarCount: similarMessages.length,
        queryPreview: this._buildSearchPreview(message),
      });

      return {
        isNewInformation: decision.object.isNewInformation,
        similarCount: similarMessages.length,
      };
    } catch (error: unknown) {
      const details: string = error instanceof Error ? error.message : String(error);

      this._logger.warn("Cron message novelty check failed, allowing send", {
        taskId,
        error: details,
      });

      return {
        isNewInformation: true,
        similarCount: 0,
      };
    }
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
        retryOptions: { callType: "cron_history" },
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

  private _parseSearchMetadata(rawMetadata: string): ISearchResultMetadata {
    try {
      return JSON.parse(rawMetadata) as ISearchResultMetadata;
    } catch {
      return {};
    }
  }

  private _buildSearchPreview(content: string): string {
    const normalized: string = content.replace(/\s+/g, " ").trim();

    if (normalized.length <= SEARCH_LOG_PREVIEW_LENGTH) {
      return normalized;
    }

    return `${normalized.slice(0, SEARCH_LOG_PREVIEW_LENGTH)}...`;
  }

  //#endregion Private methods
}

//#endregion CronMessageHistoryService
