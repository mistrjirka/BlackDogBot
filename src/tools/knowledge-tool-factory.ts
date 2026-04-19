import { tool, Tool } from "ai";
import { addKnowledgeToolInputSchema, searchKnowledgeToolInputSchema, editKnowledgeToolInputSchema, sendMessageToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { extractErrorMessage } from "../utils/error.js";
import { IKnowledgeDocument, IKnowledgeSearchResult, IKnowledgeSearchOptions, IExecutionContext } from "../shared/types/index.js";
import { CronMessageHistoryService } from "../services/cron-message-history.service.js";

export type MessageSender = (message: string) => Promise<string | null>;
export type TaskIdProvider = () => string | null;

interface ISendMessageResult {
  sent: boolean;
  messageId: string | null;
  error?: string;
  suppressedReason?: string;
  suppressedAt?: string;
}

interface IKnowledgeService {
  addKnowledgeDocumentAsync(content: string, collection?: string, metadata?: Record<string, unknown>): Promise<IKnowledgeDocument>;
  searchKnowledgeAsync(options: IKnowledgeSearchOptions): Promise<IKnowledgeSearchResult[]>;
  editKnowledgeDocumentAsync(id: string, collection: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
}

interface IMessageService {
  sendAsync(message: string): Promise<string | null>;
}

interface IKnowledgeToolFactoryDependencies {
  knowledgeService: IKnowledgeService;
  messageService: IMessageService;
}

export function createKnowledgeToolFactory(deps: IKnowledgeToolFactoryDependencies) {
  const { knowledgeService, messageService } = deps;

  return {
    createAddKnowledgeTool: (): Tool => {
      return tool({
        description: "Store new knowledge in the knowledge base. The content will be embedded and made searchable.",
        inputSchema: addKnowledgeToolInputSchema,
        execute: async ({ knowledge: knowledgeContent, collection, metadata }: { knowledge: string; collection: string; metadata: Record<string, unknown> }): Promise<{ id: string; success: boolean; error?: string }> => {
          try {
            const doc: IKnowledgeDocument = await knowledgeService.addKnowledgeDocumentAsync(knowledgeContent, collection, metadata);
            return { id: doc.id, success: true };
          } catch (error: unknown) {
            const errorMessage: string = extractErrorMessage(error);
            return { id: "", success: false, error: errorMessage };
          }
        },
      });
    },

    createSearchKnowledgeTool: (): Tool => {
      return tool({
        description: "Search the knowledge base for relevant information. Returns matching documents ranked by relevance.",
        inputSchema: searchKnowledgeToolInputSchema,
        execute: async ({ query, collection, limit }: { query: string; collection: string; limit: number }): Promise<{ results: Array<{ id: string; content: string; score: number; metadata: Record<string, unknown> }> }> => {
          const options: IKnowledgeSearchOptions = { query, collection, limit, filter: null };
          const results: IKnowledgeSearchResult[] = await knowledgeService.searchKnowledgeAsync(options);

          return {
            results: results.map((r: IKnowledgeSearchResult) => ({
              id: r.id,
              content: r.content,
              score: r.score,
              metadata: r.metadata,
            })),
          };
        },
      });
    },

    createEditKnowledgeTool: (): Tool => {
      return tool({
        description: "Edit an existing knowledge document by ID. Updates the content and re-embeds it.",
        inputSchema: editKnowledgeToolInputSchema,
        execute: async ({ id, collection, content, metadata }: { id: string; collection: string; content: string; metadata?: Record<string, unknown> }): Promise<{ success: boolean; message: string }> => {
          try {
            await knowledgeService.editKnowledgeDocumentAsync(id, collection, content, metadata);
            return { success: true, message: "Knowledge document updated successfully." };
          } catch (error: unknown) {
            return { success: false, message: (error as Error).message };
          }
        },
      });
    },

    createSendMessageTool: (): ReturnType<typeof createSendMessageTool> => {
      return createSendMessageTool(messageService.sendAsync.bind(messageService));
    },

    createSendMessageToolWithHistory: (taskIdProvider: TaskIdProvider, context: IExecutionContext): ReturnType<typeof createSendMessageToolWithHistory> => {
      return createSendMessageToolWithHistory(messageService.sendAsync.bind(messageService), taskIdProvider, context);
    },
  };
}

function createSendMessageTool(sender: MessageSender) {
  return tool({
    description:
      "Send a message to the user. Use this to communicate progress, ask clarifying questions, or deliver results.",
    inputSchema: sendMessageToolInputSchema,
    execute: async ({
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
  });
}

function createSendMessageToolWithHistory(
  sender: MessageSender,
  taskIdProvider: TaskIdProvider,
  context: IExecutionContext,
) {
  return tool({
    description:
      "Send a message to the user. Use this to communicate progress, ask clarifying questions, or deliver results. " +
      "For scheduled tasks, two checks run before sending: (1) dispatch policy always evaluates whether the message is required deliverable output vs. operational chatter, and (2) if dispatch policy allows sending and messageDedupEnabled is true, novelty checking compares the candidate message with previously sent messages from the same task and uses LLM judgment to decide whether it is new enough to send. " +
      "When messageDedupEnabled is false, novelty suppression is skipped but dispatch policy still applies.",
    inputSchema: sendMessageToolInputSchema,
    execute: async ({
      message,
    }: {
      message: string;
    }): Promise<ISendMessageResult> => {
      const suppressedAt: string = new Date().toISOString();

      try {
        const taskId: string | null = taskIdProvider();
        const historyService: CronMessageHistoryService = CronMessageHistoryService.getInstance();

        const dispatchPolicy = await historyService.checkMessageDispatchPolicyAsync(
          message,
          context.taskInstructions,
          context.taskName,
          context.taskDescription,
        );

        if (!dispatchPolicy.shouldDispatch) {
          context.toolCallHistory.push("send_message");
          return { sent: false, messageId: null, suppressedReason: "policy", suppressedAt };
        }

        const messageDedupEnabled: boolean = context.messageDedupEnabled !== false;

        if (taskId && messageDedupEnabled) {
          const novelty = await historyService.checkMessageNoveltyAsync(
            taskId,
            message,
            context.taskInstructions,
            context.taskName,
            context.taskDescription,
          );

          if (!novelty.isNewInformation) {
            context.toolCallHistory.push("send_message");

            return { sent: false, messageId: null, suppressedReason: "duplicate", suppressedAt };
          }
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
  });
}

export { createSendMessageTool, createSendMessageToolWithHistory };
