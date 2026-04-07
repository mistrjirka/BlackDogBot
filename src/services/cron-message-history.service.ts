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
  reasoning: z.string(),
  isNewInformation: z.boolean(),
});

const MessageDispatchPolicySchema = z.object({
  reasoning: z.string(),
  shouldDispatch: z.boolean(),
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
  error?: string;
}

export interface ICheckMessageDispatchResult {
  shouldDispatch: boolean;
  error?: string;
}

interface ISearchResultMetadata {
  sentAt?: string;
  taskId?: string;
}

interface IBuildNoveltyPromptInput {
  taskContextBlock: string;
  candidateMessage: string;
  similarMessagesBlock: string;
}

//#endregion Interfaces

//#region Prompt builders

export function buildCronNoveltyPrompt(input: IBuildNoveltyPromptInput): string {
  return `You are a strict deduplication checker for cron notifications.

Your job: determine whether the CANDIDATE MESSAGE describes a genuinely NEW EVENT that users have not already been notified about.

RULES:
- If the candidate and any previous message describe the SAME CORE EVENT, classify as DUPLICATE (isNewInformation=false).
- "Same core event" means same real-world incident/alert subject, even if the candidate adds new context, extra details, statistics, or stronger wording.
- Added details about an already-known event are NOT new information.
- Rephrasing, different tone, reordered wording, timestamp formatting, or style changes are NOT new information.
- Status/progress chatter ("task done", "fetched X", "processing complete") is NOT new information unless task instructions explicitly require those updates.
- Only classify as NEW when the core event itself is different (different incident/entity/location/outcome), not just richer description of the same incident.
- When uncertain, choose isNewInformation=false.

CORE EVENT TEST (must be applied first):
1) Identify the core event in the candidate.
2) Check whether that same core event appears in any previous message.
3) If yes, isNewInformation MUST be false.
4) Only if core event is absent from all previous messages may isNewInformation be true.

EXAMPLE A (duplicate -> false):
Candidate: "ENERGY ALERT: Trump threatens Iranian power plants; US weighs Kharg Island seizure"
Previous:  "ENERGY ALERT: Trump's ultimatum threatens Iranian power infrastructure; US considers seizing Kharg Island"
Reason: same core event, different wording.

EXAMPLE B (duplicate -> false):
Candidate: "ENERGY ALERT: Czech factory arson verified; IEA says crisis worse than 1970s"
Previous:  "ENERGY ALERT: Czech thermal imaging factory arson attack confirmed"
Reason: same core event (Czech factory arson). Added IEA context does not create a new event.

EXAMPLE C (new -> true):
Candidate: "ENERGY ALERT: Slovenia starts fuel rationing at 50L/day"
Previous:  "ENERGY ALERT: Trump threatens Iranian power plants; Kharg Island risk"
Reason: different core event.

OUTPUT REQUIREMENTS:
1) In \`reasoning\`, explicitly state the candidate core event and whether it already exists in previous messages (cite the matching rank numbers when applicable).
2) If core event already exists, isNewInformation MUST be false.
3) Only mark true if the candidate core event is genuinely different.

${input.taskContextBlock}

Candidate message:
${input.candidateMessage}

Top similar previous messages:
${input.similarMessagesBlock}`;
}

//#endregion Prompt builders

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

  public async checkMessageNoveltyAsync(
    taskId: string,
    message: string,
    taskInstructions?: string,
    taskName?: string,
    taskDescription?: string,
  ): Promise<ICheckMessageNoveltyResult> {
    try {
      const similarMessages: ISimilarMessage[] = await this.getSimilarMessagesAsync(message);
      const sameTaskSimilarMessages: ISimilarMessage[] = similarMessages.filter(
        (item: ISimilarMessage): boolean => item.taskId === taskId,
      );

      if (sameTaskSimilarMessages.length === 0) {
        return {
          isNewInformation: true,
          similarCount: 0,
        };
      }

      const model = AiProviderService.getInstance().getModel();
      const candidateMessage: string = message.trim();
      const similarMessagesBlock: string = sameTaskSimilarMessages
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

      const normalizedInstructions: string = (taskInstructions ?? "").trim();
      const taskContextBlock: string = normalizedInstructions.length > 0
        ? [
            "Task context:",
            `taskName: ${taskName ?? "unknown"}`,
            `taskDescription: ${taskDescription ?? ""}`,
            "taskInstructions:",
            normalizedInstructions,
          ].join("\n")
        : "Task context:\n(task instructions unavailable)";

      const noveltyPrompt: string = buildCronNoveltyPrompt({
        taskContextBlock,
        candidateMessage,
        similarMessagesBlock,
      });

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
        reasoning: decision.object.reasoning,
        similarCount: sameTaskSimilarMessages.length,
        queryPreview: this._buildSearchPreview(message),
      });

      return {
        isNewInformation: decision.object.isNewInformation,
        similarCount: sameTaskSimilarMessages.length,
      };
    } catch (error: unknown) {
      const details: string = error instanceof Error ? error.message : String(error);

      this._logger.warn("Cron message novelty check failed", {
        taskId,
        error: details,
      });

      return {
        isNewInformation: false,
        similarCount: 0,
        error: details,
      };
    }
  }

  public async checkMessageDispatchPolicyAsync(
    message: string,
    taskInstructions?: string,
    taskName?: string,
    taskDescription?: string,
  ): Promise<ICheckMessageDispatchResult> {
    try {
      const normalizedInstructions: string = (taskInstructions ?? "").trim();
      if (normalizedInstructions.length === 0) {
        return { shouldDispatch: true };
      }

      const model = AiProviderService.getInstance().getModel();
      const candidateMessage: string = message.trim();

      const prompt: string = `You are a strict cron notification policy checker.

Decide whether the candidate message should be dispatched to the user based on task instructions.

Rule: If task instructions indicate silent/background execution or say not to send status/progress updates, then status/progress messages must NOT be dispatched.

Allow dispatch only when at least one is true:
1) Task instructions explicitly require sending this kind of update, or
2) Candidate message contains a critical error/warning requiring user action, or
3) Candidate message is the requested final deliverable/output.

Status/progress messages include: "task complete", "fetched X", "processed Y", "stored records", "silent operation complete", and similar operational summaries.

If unsure, prefer shouldDispatch=false.

EXAMPLE A (dispatch=false):
Task instructions: "Run silently. Send only critical alerts."
Candidate: "Task complete: fetched 16 articles, stored in DB."
Reason: routine status update, not a critical alert, must be suppressed.

EXAMPLE B (dispatch=true):
Task instructions: "Run silently. Send only critical alerts."
Candidate: "ENERGY ALERT: Strait disruption now impacting Czechia-relevant supply routes."
Reason: this is a critical alert class explicitly allowed by instructions.

OUTPUT REQUIREMENTS:
1) In \`reasoning\`, cite which instruction lines allow or forbid this message type.
2) Decide shouldDispatch accordingly.

Task context:
taskName: ${taskName ?? "unknown"}
taskDescription: ${taskDescription ?? ""}
taskInstructions:
${normalizedInstructions}

Candidate message:
${candidateMessage}`;

      const decision = await generateObjectWithRetryAsync({
        model,
        schema: MessageDispatchPolicySchema,
        prompt,
        retryOptions: {
          callType: "schema_extraction",
        },
      });

      this._logger.info("Cron message dispatch policy decision computed", {
        shouldDispatch: decision.object.shouldDispatch,
        reasoning: decision.object.reasoning,
        queryPreview: this._buildSearchPreview(message),
      });

      return {
        shouldDispatch: decision.object.shouldDispatch,
      };
    } catch (error: unknown) {
      const details: string = error instanceof Error ? error.message : String(error);

      this._logger.warn("Cron message dispatch policy check failed", {
        error: details,
      });

      return {
        shouldDispatch: false,
        error: details,
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
