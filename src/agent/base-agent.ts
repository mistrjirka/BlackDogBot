import {
  ToolLoopAgent,
  ToolSet,
  LanguageModel,
  hasToolCall,
  type ModelMessage,
  type Tool,
} from "ai";

import { doneTool } from "../tools/done.tool.js";
import { LoggerService } from "../services/logger.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { generateTextWithRetryAsync } from "../utils/llm-retry.js";
import { getForceThinkDirective } from "../utils/prepare-step.js";
import { encodingForModel } from "js-tiktoken";

//#region Constants

/**
 * Default token threshold for compaction. When the total token count of the
 * message history exceeds this value, older messages are summarized.
 * Using 80k as the default — leaves room for the model's output and system prompt
 * on a typical 128k context window.
 */
const DEFAULT_COMPACTION_TOKEN_THRESHOLD: number = 80_000;

/**
 * Number of recent messages to always keep verbatim during compaction.
 */
const COMPACTION_KEEP_RECENT: number = 6;

//#endregion Constants

//#region Interfaces

export interface IAgentResult {
  text: string;
  stepsCount: number;
}

export interface IToolCallSummary {
  name: string;
  input: Record<string, unknown>;
}

export type OnStepCallback = (stepNumber: number, toolCalls: IToolCallSummary[]) => Promise<void>;

export interface IBaseAgentOptions {
  maxSteps?: number;
  compactionTokenThreshold?: number;
}

//#endregion Interfaces

//#region BaseAgent

export abstract class BaseAgentBase {
  //#region Data members

  protected _agent: ToolLoopAgent | null;
  protected _logger: LoggerService;
  protected _initialized: boolean;
  protected _maxSteps: number;
  protected _compactionTokenThreshold: number;

  //#endregion Data members

  //#region Constructors

  protected constructor(options?: IBaseAgentOptions) {
    this._agent = null;
    this._logger = LoggerService.getInstance();
    this._initialized = false;
    this._maxSteps = options?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    this._compactionTokenThreshold = options?.compactionTokenThreshold ?? DEFAULT_COMPACTION_TOKEN_THRESHOLD;
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
    onStepAsync?: OnStepCallback,
    customDoneTool?: Tool,
  ): void {
    const maxSteps: number = this._maxSteps;
    const compactionTokenThreshold: number = this._compactionTokenThreshold;
    const logger: LoggerService = this._logger;
    const compactionModel: LanguageModel = model;

    const allTools: ToolSet = {
      ...tools,
      done: customDoneTool ?? doneTool,
    };

    this._agent = new ToolLoopAgent({
      model,
      instructions,
      tools: allTools,
      stopWhen: [
        hasToolCall("done"),
      ],
      prepareStep: async ({ stepNumber, messages }) => {
        // Notify about completed previous step before doing anything else
        if (stepNumber > 0 && onStepAsync) {
          const toolCalls: IToolCallSummary[] = _extractLastAssistantToolCalls(messages);

          try {
            await onStepAsync(stepNumber, toolCalls);
          } catch {
            // Ignore step callback errors — never let UI failures affect agent execution
          }
        }

        // Force think tool every N steps to ensure the agent reflects periodically
        const forceThink = getForceThinkDirective(stepNumber, messages);

        if (forceThink) {
          return forceThink;
        }

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

        // Token-based history compaction: summarize old messages when token count is too high
        const tokenCount: number = _countTokens(messages);

        if (tokenCount > compactionTokenThreshold) {
          logger.info("Compacting agent history", {
            tokenCount,
            threshold: compactionTokenThreshold,
            messageCount: messages.length,
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

/**
 * Count tokens across all messages using cl100k_base encoding (GPT-4/Claude compatible).
 * This provides a reasonable approximation for most LLM providers.
 */
function _countTokens(messages: ModelMessage[]): number {
  const enc = encodingForModel("gpt-4o");
  let totalTokens: number = 0;

  for (const msg of messages) {
    const text: string = _extractTextContent(msg);

    totalTokens += enc.encode(text).length;
  }

  return totalTokens;
}

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

  const tokensBefore: number = _countTokens(messages);
  const compactedResult: ModelMessage[] = [firstMessage, {
    role: "user",
    content: [
      {
        type: "text",
        text: `[CONVERSATION SUMMARY - Earlier messages were compacted]\n\n${summaryText}\n\n[END OF SUMMARY - Recent conversation follows]`,
      },
    ],
  }, ...recentMessages];

  const tokensAfter: number = _countTokens(compactedResult);

  logger.debug("History compaction complete", {
    originalMessages: messages.length,
    compactedMessages: compactedResult.length,
    tokensBefore,
    tokensAfter,
    summaryLength: summaryText.length,
  });

  return compactedResult;
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

function _extractLastAssistantToolCalls(messages: ModelMessage[]): IToolCallSummary[] {
  for (let i: number = messages.length - 1; i >= 0; i--) {
    const msg: ModelMessage = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const calls: IToolCallSummary[] = [];

      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "tool-call" &&
          "toolName" in part &&
          typeof (part as { toolName: unknown }).toolName === "string"
        ) {
          calls.push({
            name: (part as { toolName: string }).toolName,
            input: ((part as { input: unknown }).input ?? {}) as Record<string, unknown>,
          });
        }
      }

      if (calls.length > 0) {
        return calls;
      }
    }
  }

  return [];
}

//#endregion Private functions
