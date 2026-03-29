import { LoggerService } from "./logger.service.js";
import { ConfigService } from "./config.service.js";
import { createChatModel } from "./langchain-model.service.js";
import { EmbeddingService } from "./embedding.service.js";
import { VectorStoreService } from "./vector-store.service.js";
import { generateId } from "../utils/id.js";
import type { ICronMessageHistory } from "../shared/types/index.js";
import {
  buildCronDispatchPolicyPrompt,
  buildCronNoveltyPrompt,
  buildSearchPreview,
  parseSearchMetadata,
  type ISearchResultMetadata,
} from "./cron-message-history-helpers.js";
import { z } from "zod";

export { buildCronNoveltyPrompt } from "./cron-message-history-helpers.js";

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

type MessageNoveltyDecision = z.infer<typeof MessageNoveltySchema>;
type MessageDispatchDecision = z.infer<typeof MessageDispatchPolicySchema>;

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

export interface ICheckMessageDispatchResult {
  shouldDispatch: boolean;
}

//#endregion Interfaces

//#region Helper methods

function _extractTextFromAiContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = content
      .filter((part: unknown): part is { type: string; text?: unknown } => typeof part === "object" && part !== null)
      .filter((part: { type: string; text?: unknown }): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part: { type: "text"; text: string }) => part.text);

    return textParts.join("\n").trim();
  }

  return "";
}

function _extractTextFromReasoningContent(additionalKwargs: unknown): string {
  if (typeof additionalKwargs !== "object" || additionalKwargs === null) {
    return "";
  }

  const rawReasoning: unknown = (additionalKwargs as { reasoning_content?: unknown }).reasoning_content;
  if (typeof rawReasoning === "string") {
    return rawReasoning;
  }

  return "";
}

function _extractTopLevelJsonObjectCandidates(rawText: string): string[] {
  const candidates: string[] = [];
  let depth: number = 0;
  let inString: boolean = false;
  let escape: boolean = false;
  let objectStart: number = -1;

  for (let i: number = 0; i < rawText.length; i++) {
    const char: string = rawText[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\") {
        escape = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        objectStart = i;
      }

      depth++;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }

      depth--;
      if (depth === 0 && objectStart >= 0) {
        candidates.push(rawText.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }

  return candidates;
}

function _parseStructuredDecisionOrThrow<TSchema extends z.ZodTypeAny>(
  rawText: string,
  schema: TSchema,
  label: string,
): z.infer<TSchema> {
  const trimmed: string = rawText.trim();

  const parseWithSchema = (candidate: string): z.infer<TSchema> | null => {
    try {
      const parsedJson: unknown = JSON.parse(candidate);
      const parsed = schema.safeParse(parsedJson);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const candidates: string[] = [trimmed, ..._extractTopLevelJsonObjectCandidates(trimmed)];

  for (const candidate of candidates) {
    const parsed: z.infer<TSchema> | null = parseWithSchema(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new Error(`${label}: ${trimmed.slice(0, 200)}`);
}

async function _invokeStructuredDecisionAsync<TSchema extends z.ZodTypeAny>(
  prompt: string,
  schema: TSchema,
  logger: LoggerService,
  logLabel: string,
): Promise<z.infer<TSchema>> {
  const model = createChatModel(ConfigService.getInstance().getAiConfig());
  const response = await model.invoke(prompt);

  const rawText: string = _extractTextFromAiContent(response.content);
  const rawReasoningText: string = _extractTextFromReasoningContent(
    (response as { additional_kwargs?: unknown }).additional_kwargs,
  );

  logger.debug(`${logLabel} raw response`, {
    contentPreview: rawText.slice(0, 200),
    reasoningPreview: rawReasoningText.slice(0, 200),
    contentLength: rawText.length,
    reasoningLength: rawReasoningText.length,
  });

  const mergedRawText: string = [rawText, rawReasoningText]
    .filter((value: string): boolean => value.trim().length > 0)
    .join("\n");

  return _parseStructuredDecisionOrThrow(mergedRawText, schema, `${logLabel} returned invalid structured response`);
}

//#endregion Helper methods

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
      const metadata: ISearchResultMetadata = parseSearchMetadata(result.metadata);

      return {
        content: result.content,
        sentAt: metadata.sentAt ?? "",
        score: result.score,
        taskId: metadata.taskId ?? result.collection,
      };
    });

    this._logger.info("Cron similar message search completed", {
      queryLength: message.length,
      queryPreview: buildSearchPreview(message, SEARCH_LOG_PREVIEW_LENGTH),
      resultCount: similarMessages.length,
      results: similarMessages.map((item: ISimilarMessage, index: number) => ({
        rank: index + 1,
        score: Number(item.score.toFixed(4)),
        taskId: item.taskId,
        sentAt: item.sentAt,
        preview: buildSearchPreview(item.content, SEARCH_LOG_PREVIEW_LENGTH),
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

    const decision: MessageNoveltyDecision = await _invokeStructuredDecisionAsync(
      noveltyPrompt,
      MessageNoveltySchema,
      this._logger,
      "Cron message novelty decision",
    );

    this._logger.info("Cron message novelty decision computed", {
      taskId,
      isNewInformation: decision.isNewInformation,
      reasoning: decision.reasoning,
      similarCount: sameTaskSimilarMessages.length,
      queryPreview: buildSearchPreview(message, SEARCH_LOG_PREVIEW_LENGTH),
    });

    return {
      isNewInformation: decision.isNewInformation,
      similarCount: sameTaskSimilarMessages.length,
    };
  }

  public async checkMessageDispatchPolicyAsync(
    message: string,
    taskInstructions?: string,
    taskName?: string,
    taskDescription?: string,
  ): Promise<ICheckMessageDispatchResult> {
    const normalizedInstructions: string = (taskInstructions ?? "").trim();
    if (normalizedInstructions.length === 0) {
      return { shouldDispatch: true };
    }

    const candidateMessage: string = message.trim();
    const prompt: string = buildCronDispatchPolicyPrompt({
      taskInstructions: normalizedInstructions,
      taskName,
      taskDescription,
      candidateMessage,
    });

    const decision: MessageDispatchDecision = await _invokeStructuredDecisionAsync(
      prompt,
      MessageDispatchPolicySchema,
      this._logger,
      "Cron message dispatch policy decision",
    );

    this._logger.info("Cron message dispatch policy decision computed", {
      shouldDispatch: decision.shouldDispatch,
      reasoning: decision.reasoning,
      queryPreview: buildSearchPreview(message, SEARCH_LOG_PREVIEW_LENGTH),
    });

    return {
      shouldDispatch: decision.shouldDispatch,
    };
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
      const model = createChatModel(ConfigService.getInstance().getAiConfig());

      const result = await model.invoke(prompt);

      const newSummary: string = typeof result.content === "string" ? result.content : "";

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
