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
import { StatusService } from "../services/status.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { generateTextWithRetryAsync } from "../utils/llm-retry.js";
import { getForceThinkDirective } from "../utils/prepare-step.js";
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { encodingForModel } from "js-tiktoken";

//#region Constants

/**
 * Default context window size for modern models (tokens).
 */
const DEFAULT_CONTEXT_WINDOW: number = 128_000;

/**
 * Percentage of context window to use as compaction threshold.
 * When token count exceeds this percentage, older messages are summarized.
 */
const COMPACTION_THRESHOLD_PERCENTAGE: number = 0.75;

/**
 * Number of recent messages to always keep verbatim during compaction.
 */
const COMPACTION_KEEP_RECENT: number = 6;

/**
 * How many times to retry the full agent generate call when the model
 * returns a completely empty response (no text, no useful tool calls).
 */
export const AGENT_EMPTY_RESPONSE_RETRIES: number = 4 ;

//#endregion Constants

//#region Interfaces

export interface IAgentResult {
  text: string;
  stepsCount: number;
}

export interface IToolCallSummary {
  name: string;
  input: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
}

export type OnStepCallback = (stepNumber: number, toolCalls: IToolCallSummary[]) => Promise<void>;

export interface IBaseAgentOptions {
  maxSteps?: number;
  contextWindow?: number;  // Optional, defaults to DEFAULT_CONTEXT_WINDOW
}

//#endregion Interfaces

//#region BaseAgent

export abstract class BaseAgentBase {
  //#region Data members

  protected _agent: ToolLoopAgent | null;
  protected _logger: LoggerService;
  protected _initialized: boolean;
  protected _maxSteps: number;
  protected _contextWindow: number;
  protected _compactionTokenThreshold: number;
  protected _totalInputTokens: number = 0;

  //#endregion Data members

  //#region Constructors

  protected constructor(options?: IBaseAgentOptions) {
    this._agent = null;
    this._logger = LoggerService.getInstance();
    this._initialized = false;
    this._maxSteps = options?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    this._contextWindow = options?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this._compactionTokenThreshold = Math.floor(this._contextWindow * COMPACTION_THRESHOLD_PERCENTAGE);
  }

  //#endregion Constructors

  //#region Public methods

  public async processMessageAsync(userMessage: string): Promise<IAgentResult> {
    this._ensureInitialized();

    this._logger.debug("Processing user message", { messageLength: userMessage.length });

    const statusService: StatusService = StatusService.getInstance();

    try {
      // Set status to show AI is thinking (in-flight)
      statusService.beginInFlight("llm_request", "Thinking...", {});

      for (let attempt: number = 1; attempt <= AGENT_EMPTY_RESPONSE_RETRIES + 1; attempt++) {
        // Reset token count so prepareStep doesn't use stale values from a failed attempt
        this._totalInputTokens = 0;

        const result = await this._agent!.generate({ prompt: userMessage });

        let text: string = result.text ?? "";

        if (text.trim().length === 0) {
          const steps = result.steps;

          if (Array.isArray(steps)) {
            for (let i: number = steps.length - 1; i >= 0; i--) {
              const step = steps[i] as { toolCalls?: unknown };
              const toolCalls = step.toolCalls;

              if (Array.isArray(toolCalls)) {
                for (let j: number = toolCalls.length - 1; j >= 0; j--) {
                  const toolCall = toolCalls[j] as { toolName?: unknown; name?: unknown; args?: unknown; input?: unknown };
                  const toolName: string | undefined =
                    typeof toolCall.toolName === "string"
                      ? toolCall.toolName
                      : (typeof toolCall.name === "string" ? toolCall.name : undefined);

                  if (toolName === "done") {
                    const args = (toolCall.args ?? toolCall.input) as { summary?: unknown } | undefined;
                    const summary: string = typeof args?.summary === "string" ? args.summary : "";

                    if (summary.trim().length > 0) {
                      text = summary;
                      break;
                    }
                  }
                }
              }

              if (text.trim().length > 0) {
                break;
              }
            }
          }
        }

        // Track API-reported token usage
        const inputTokens = result.totalUsage?.inputTokens ?? result.usage?.inputTokens;
        if (inputTokens !== undefined) {
          this._totalInputTokens = inputTokens;
        } else {
          this._totalInputTokens = 0;
          this._logger.warn("Token usage missing from LLM response; using tiktoken fallback.");
        }

        const stepsCount: number = result.steps?.length ?? 1;

        // If we got text, return immediately
        if (text.trim()) {
          this._logger.debug("Agent response generated", { stepsCount });
          return { text, stepsCount };
        }

        // Empty response — retry if we have attempts left
        if (attempt <= AGENT_EMPTY_RESPONSE_RETRIES) {
          this._logger.warn("Model returned empty response, retrying agent generate", {
            attempt,
            maxRetries: AGENT_EMPTY_RESPONSE_RETRIES,
          });
          continue;
        }

        // All retries exhausted
        this._logger.error("Model returned empty response after all retries", {
          attempts: attempt,
        });

        return {
          text: "I was unable to complete your request — the model returned empty responses after multiple retries. Please try again.",
          stepsCount,
        };
      }

      // Should not be reached, but satisfy TypeScript
      return { text: "Unexpected error.", stepsCount: 0 };
    } finally {
      statusService.endInFlight();
    }
  }

  //#endregion Public methods

  //#region Protected methods

  protected _buildAgent(
    model: LanguageModel,
    instructions: string,
    tools: ToolSet,
    onStepAsync?: OnStepCallback,
    customDoneTool?: Tool,
    getExtraTools?: () => ToolSet | null,
    extraTools?: ToolSet,
    getPausePromise?: () => Promise<void> | null,
    getCreationModePrompt?: () => string | null,
  ): void {
    const self = this; // Capture this for use in callbacks
    const maxSteps: number = this._maxSteps;
    const compactionTokenThreshold: number = this._compactionTokenThreshold;
    const logger: LoggerService = this._logger;
    const compactionModel: LanguageModel = model;

    const allTools: ToolSet = {
      ...tools,
      ...(extraTools ?? {}),
      done: customDoneTool ?? doneTool,
    };

    /** Names of the base tools (always visible). */
    const baseToolNames: string[] = Object.keys({ ...tools, done: customDoneTool ?? doneTool });
    /** Names of extra (mode-gated) tools — registered but hidden by default. */
    const extraToolNames: string[] = Object.keys(extraTools ?? {});

    // Pre-compute the fixed token overhead that's included in every API request
    // but not in the messages array: system prompt + tool definitions.
    // This is critical for accurate context window tracking.
    const fixedOverheadTokens: number = _estimateFixedOverhead(instructions, allTools);
    logger.debug("Computed fixed token overhead for context tracking", {
      systemPromptTokens: _countTextTokens(instructions),
      toolCount: Object.keys(allTools).length,
      totalOverhead: fixedOverheadTokens,
    });

    this._agent = new ToolLoopAgent({
      model,
      instructions,
      tools: allTools,
      stopWhen: [
        hasToolCall("done"),
      ],
      experimental_repairToolCall: repairToolCallJsonAsync,
      prepareStep: async ({ stepNumber, messages }) => {
        // Determine whether extra tools should be active this step
        const activeExtraTools: ToolSet | null = getExtraTools ? getExtraTools() : null;
        const useExtraTools: boolean = activeExtraTools !== null && extraToolNames.length > 0;

        // Compute the active tool name list for this step
        const activeToolNames: (keyof typeof allTools)[] = useExtraTools
          ? (Object.keys(allTools) as (keyof typeof allTools)[])
          : (baseToolNames as (keyof typeof allTools)[]);

        // Notify about completed previous step before doing anything else
        if (stepNumber > 0 && onStepAsync) {
          const toolCalls: IToolCallSummary[] = _extractLastAssistantToolCalls(messages);

          try {
            await onStepAsync(stepNumber, toolCalls);
          } catch {
            // Ignore step callback errors — never let UI failures affect agent execution
          }
        }

        // Detect silent exit: if the previous step was the model producing text
        // without calling any tools, force it to call done so the user gets a summary.
        if (stepNumber > 0) {
          const lastMsg: ModelMessage = messages[messages.length - 1];

          if (lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
            const hasToolCalls: boolean = lastMsg.content.some(
              (p: unknown) =>
                typeof p === "object" && p !== null && "type" in p &&
                (p as { type: string }).type === "tool-call",
            );

            if (!hasToolCalls) {
              logger.warn("Model tried to stop without calling done — forcing done tool", { stepNumber });

              return {
                activeTools: ["done"] as (keyof typeof allTools)[],
                toolChoice: { type: "tool" as const, toolName: "done" },
              };
            }
          }
        }

        // Force think tool every N steps to ensure the agent reflects periodically
        const forceThink = getForceThinkDirective(stepNumber, messages);

        // Check for pause — await the promise if the agent has been paused
        const pausePromise: Promise<void> | null = getPausePromise ? getPausePromise() : null;

        if (pausePromise) {
          logger.info("Agent paused, waiting for resume...");
          await pausePromise;
          logger.info("Agent resumed.");
        }

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

        // Token-based history compaction: count message tokens + fixed overhead
        // (system prompt + tool definitions) for an accurate total.
        const messageTokens: number = _countTokens(messages);
        const tokenCount: number = messageTokens + fixedOverheadTokens;

        // Update status service with context info (including percentage for UI display)
        const statusService: StatusService = StatusService.getInstance();
        statusService.setContextTokensWithThreshold(tokenCount, compactionTokenThreshold, self._contextWindow);

        if (tokenCount > compactionTokenThreshold) {
          logger.info("Compacting agent history", {
            tokenCount,
            messageTokens,
            fixedOverhead: fixedOverheadTokens,
            threshold: compactionTokenThreshold,
            messageCount: messages.length,
          });

          const compactedMessages: ModelMessage[] = await _compactMessagesAsync(
            messages,
            compactionModel,
            logger,
          );

          return { messages: compactedMessages, activeTools: activeToolNames };
        }

        // When extra tools are active, inject the creation mode guide into the system prompt
        // and return activeTools so the LLM can see them; when not in creation mode and
        // there are no extra tools, return {} (no restriction).
        if (extraToolNames.length > 0) {
          if (useExtraTools && getCreationModePrompt) {
            const creationPrompt: string | null = getCreationModePrompt();

            if (creationPrompt) {
              return { system: `${instructions}\n\n${creationPrompt}`, activeTools: activeToolNames };
            }
          }

          return { activeTools: activeToolNames };
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
 * Count tokens in a plain text string using cl100k_base encoding.
 */
function _countTextTokens(text: string): number {
  const enc = encodingForModel("gpt-4o");
  return enc.encode(text).length;
}

/**
 * Estimate the fixed token overhead per API request from the system prompt
 * and tool definitions. This is computed once at agent build time.
 *
 * Tool definitions contribute significantly: each tool sends its name,
 * description, and full JSON schema to the LLM. For 30+ tools with
 * complex zod schemas, this can easily be 30,000–50,000+ tokens.
 */
function _estimateFixedOverhead(instructions: string, allTools: ToolSet): number {
  let overhead: number = _countTextTokens(instructions);

  // Estimate tool definition tokens by serializing what the API sends
  for (const [name, toolDef] of Object.entries(allTools)) {
    // Tool name + overhead per tool (~10 tokens for JSON structure)
    overhead += _countTextTokens(name) + 10;

    // Tool description
    if (toolDef && typeof toolDef === "object") {
      const desc: unknown = (toolDef as Record<string, unknown>).description;
      if (typeof desc === "string") {
        overhead += _countTextTokens(desc);
      }

      // Tool input schema (JSON schema) — the biggest contributor
      const params: unknown = (toolDef as Record<string, unknown>).parameters;
      if (params && typeof params === "object") {
        const schemaStr: string = JSON.stringify(params);
        overhead += _countTextTokens(schemaStr);
      }
    }
  }

  return overhead;
}

/**
 * Count tokens across all messages using cl100k_base encoding (GPT-4/Claude compatible).
 * This provides a reasonable approximation for most LLM providers.
 * Note: This counts only message content, not system prompt or tool definitions.
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
            toolCallId: (part as { toolCallId?: string }).toolCallId,
            name: (part as { toolName: string }).toolName,
            input: ((part as { args?: unknown }).args ?? (part as { input?: unknown }).input ?? {}) as Record<string, unknown>,
          });
        }
      }

      if (calls.length > 0) {
        // Look ahead for tool results
        for (let j = i + 1; j < messages.length; j++) {
          const nextMsg = messages[j];
          if (nextMsg.role === "tool" && Array.isArray(nextMsg.content)) {
            for (const nextPart of nextMsg.content) {
              if (
                typeof nextPart === "object" &&
                nextPart !== null &&
                "type" in nextPart &&
                (nextPart as { type: string }).type === "tool-result"
              ) {
                const resPart = nextPart as { toolCallId?: string; result?: unknown; output?: unknown; isError?: boolean };
                const matchedCall = calls.find(c => c.toolCallId === resPart.toolCallId);
                
                // Extract actual result value
                let actualResult = resPart.result;
                if (actualResult === undefined && resPart.output !== undefined) {
                  // Handle LanguageModelV3ToolResultOutput format used by internal ModelMessage
                  const outObj = resPart.output as { type?: string; value?: unknown };
                  if (outObj && typeof outObj === "object" && outObj.value !== undefined) {
                    actualResult = outObj.value;
                  } else {
                    actualResult = resPart.output;
                  }
                }

                if (matchedCall) {
                  matchedCall.result = actualResult ?? null; 
                  matchedCall.isError = resPart.isError;
                } else {
                  // Fallback: if no toolCallId matched or wasn't provided, try matching by name
                  const toolName = (resPart as { toolName?: string }).toolName;
                  const matchedByName = calls.find(c => c.name === toolName && c.result === undefined);
                  if (matchedByName) {
                    matchedByName.result = actualResult ?? null;
                    matchedByName.isError = resPart.isError;
                  }
                }
              }
            }
          }
        }
        return calls;
      }
    }
  }

  return [];
}

//#endregion Private functions
