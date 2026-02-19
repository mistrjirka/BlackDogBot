import {
  ToolLoopAgent,
  ToolSet,
  LanguageModel,
  hasToolCall,
  type ModelMessage,
} from "ai";

import { doneTool } from "../tools/done.tool.js";
import { LoggerService } from "../services/logger.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { generateTextWithRetryAsync } from "../utils/llm-retry.js";

//#region Constants

const DEFAULT_COMPACTION_THRESHOLD: number = 40;
const COMPACTION_KEEP_RECENT: number = 6;

//#endregion Constants

//#region Interfaces

export interface IAgentResult {
  text: string;
  stepsCount: number;
}

export interface IBaseAgentOptions {
  maxSteps?: number;
  compactionThreshold?: number;
}

//#endregion Interfaces

//#region BaseAgent

export abstract class BaseAgentBase {
  //#region Data members

  protected _agent: ToolLoopAgent | null;
  protected _logger: LoggerService;
  protected _initialized: boolean;
  protected _maxSteps: number;
  protected _compactionThreshold: number;

  //#endregion Data members

  //#region Constructors

  protected constructor(options?: IBaseAgentOptions) {
    this._agent = null;
    this._logger = LoggerService.getInstance();
    this._initialized = false;
    this._maxSteps = options?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    this._compactionThreshold = options?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  }

  //#endregion Constructors

  //#region Public methods

  public async processMessageAsync(userMessage: string): Promise<IAgentResult> {
    this._ensureInitialized();

    this._logger.debug("Processing user message", { messageLength: userMessage.length });

    const result = await this._agent!.generate({ prompt: userMessage });

    const stepsCount: number = result.steps?.length ?? 1;

    this._logger.debug("Agent response generated", { stepsCount });

    return {
      text: result.text ?? "",
      stepsCount,
    };
  }

  //#endregion Public methods

  //#region Protected methods

  protected _buildAgent(
    model: LanguageModel,
    instructions: string,
    tools: ToolSet,
  ): void {
    const maxSteps: number = this._maxSteps;
    const compactionThreshold: number = this._compactionThreshold;
    const logger: LoggerService = this._logger;
    const compactionModel: LanguageModel = model;

    const allTools: ToolSet = {
      ...tools,
      done: doneTool,
    };

    this._agent = new ToolLoopAgent({
      model,
      instructions,
      tools: allTools,
      stopWhen: [
        hasToolCall("done"),
      ],
      prepareStep: async ({ stepNumber, messages }) => {
        // Force done tool on last step
        if (stepNumber >= maxSteps - 1) {
          logger.warn("Agent reached max steps, forcing done tool", {
            stepNumber,
            maxSteps,
          });

          return {
            activeTools: ["done"] as (keyof typeof allTools)[],
            toolChoice: { type: "tool" as const, toolName: "done" },
          };
        }

        // History compaction: summarize old messages when threshold exceeded
        if (messages.length > compactionThreshold) {
          logger.info("Compacting agent history", {
            messageCount: messages.length,
            threshold: compactionThreshold,
          });

          const compactedMessages: ModelMessage[] = await _compactMessagesAsync(
            messages,
            compactionModel,
            logger,
          );

          return { messages: compactedMessages };
        }

        return {};
      },
    });

    this._initialized = true;
  }

  protected _ensureInitialized(): void {
    if (!this._initialized || !this._agent) {
      throw new Error(`${this.constructor.name} not initialized. Call initializeAsync() first.`);
    }
  }

  //#endregion Protected methods
}

//#endregion BaseAgent

//#region Private functions

async function _compactMessagesAsync(
  messages: ModelMessage[],
  model: LanguageModel,
  logger: LoggerService,
): Promise<ModelMessage[]> {
  const firstMessage: ModelMessage = messages[0];
  const recentMessages: ModelMessage[] = messages.slice(-COMPACTION_KEEP_RECENT);
  const oldMessages: ModelMessage[] = messages.slice(1, -COMPACTION_KEEP_RECENT);

  if (oldMessages.length === 0) {
    return messages;
  }

  const oldConversationText: string = oldMessages
    .map((msg: ModelMessage): string => {
      if (msg.role === "user") {
        return `[User]: ${_extractTextContent(msg)}`;
      }

      if (msg.role === "assistant") {
        return `[Assistant]: ${_extractTextContent(msg)}`;
      }

      if (msg.role === "tool") {
        return `[Tool result]: ${_extractTextContent(msg)}`;
      }

      return `[${msg.role}]: ${_extractTextContent(msg)}`;
    })
    .join("\n");

  const summaryResult = await generateTextWithRetryAsync({
    model,
    prompt: `Summarize the following conversation history concisely. Focus on key decisions made, actions taken, important context, and any pending tasks. Be thorough but brief.\n\n${oldConversationText}`,
  });

  const summaryText: string = summaryResult.text || "No summary available.";

  logger.debug("History compaction complete", {
    originalCount: messages.length,
    compactedCount: 2 + recentMessages.length,
    summaryLength: summaryText.length,
  });

  const summaryMessage: ModelMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `[CONVERSATION SUMMARY - Earlier messages were compacted]\n\n${summaryText}\n\n[END OF SUMMARY - Recent conversation follows]`,
      },
    ],
  };

  return [firstMessage, summaryMessage, ...recentMessages];
}

function _extractTextContent(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    const parts: string[] = [];

    for (const part of message.content) {
      if ("text" in part && typeof part.text === "string") {
        parts.push(part.text);
      } else if ("result" in part) {
        parts.push(JSON.stringify(part.result));
      }
    }

    return parts.join(" ");
  }

  return "";
}

//#endregion Private functions
