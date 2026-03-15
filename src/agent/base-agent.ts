import {
  ToolLoopAgent,
  ToolSet,
  LanguageModel,
  hasToolCall,
  APICallError,
  type ModelMessage,
  type Tool,
} from "ai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { encodingForModel } from "js-tiktoken";

import { doneTool } from "../tools/done.tool.js";
import { LoggerService } from "../services/logger.service.js";
import { StatusService } from "../services/status.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { getDuplicateToolCallDirective } from "../utils/prepare-step.js";
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { wrapToolSetWithReasoning } from "../utils/tool-reasoning-wrapper.js";
import { compactMessagesSummaryOnlyAsync } from "../utils/summarization-compaction.js";

//#region Constants

/**
 * Default context window size for modern models (tokens).
 */
const DEFAULT_CONTEXT_WINDOW: number = 128_000;

/**
 * Percentage of context window to use as compaction threshold.
 * When token count exceeds this percentage, older messages are summarized.
 */
const COMPACTION_THRESHOLD_PERCENTAGE: number = 0.70;

/**
 * Hard gate threshold for blocking requests at the fetch level.
 * Requests exceeding this percentage of context window are rejected
 * with a synthetic 400 error to trigger compaction.
 */
export const HARD_GATE_THRESHOLD_PERCENTAGE: number = 0.85;

/**
 * How many times to retry the full agent generate call when the model
 * returns a completely empty response (no text, no useful tool calls).
 */
export const AGENT_EMPTY_RESPONSE_RETRIES: number = 4;

/**
 * How many times to retry with compaction when receiving 400 context exceeded errors.
 */
export const CONTEXT_EXCEEDED_RETRIES: number = 2;

/**
 * Approximate JSON structure overhead per message in OpenAI format.
 * Accounts for: {"role":"...","content":"..."} wrapper
 */
const MESSAGE_JSON_OVERHEAD_TOKENS: number = 15;

/**
 * Token budget reserved for predictive compaction headroom.
 * Compaction triggers earlier by this amount to leave room for the next turn.
 */
const COMPACTION_HEADROOM_TOKENS: number = 4000;

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
  protected _fixedOverheadTokens: number = 0;
  protected _totalInputTokens: number = 0;
  protected _forceCompactionOnNextStep: boolean = false;

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

  /**
   * Update the context window size after initialization (e.g. once the real
   * model context window is known from the provider). Recalculates the
   * compaction threshold.
   */
  public updateContextWindow(contextWindow: number): void {
    this._contextWindow = contextWindow;
    this._compactionTokenThreshold = Math.floor(contextWindow * COMPACTION_THRESHOLD_PERCENTAGE);
    this._logger.info("Context window updated", {
      contextWindow,
      compactionThreshold: this._compactionTokenThreshold,
    });
  }

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

        let result;

        try {
          result = await this._agent!.generate({ prompt: userMessage });
        } catch (error: unknown) {
          // Enhanced error logging for AI provider errors
          if (APICallError.isInstance(error)) {
            const responseBodyLength = error.responseBody?.length ?? 0;
            const responseBodyPreview = error.responseBody
              ? error.responseBody.substring(0, Math.min(1000, responseBodyLength)) + 
                (responseBodyLength > 1000 ? "..." : "")
              : undefined;
              
            this._logger.error("AI provider API call failed", {
              attempt,
              statusCode: error.statusCode,
              message: error.message,
              responseBodyPreview,
              url: error.url,
            });
          } else if (error instanceof Error) {
            this._logger.error("AI call failed with error", {
              attempt,
              errorName: error.name,
              errorMessage: error.message,
              errorStack: error.stack?.split('\n').slice(0, 5).join('\n'),
            });
          } else {
            this._logger.error("AI call failed with unknown error", {
              attempt,
              error: String(error),
            });
          }

          // Handle context exceeded errors with reactive compaction
          // Covers: 400 (hard gate), 500 (provider), 413/422 (other providers)
          if (
            APICallError.isInstance(error) &&
            (error.statusCode === 400 || error.statusCode === 500 || error.statusCode === 413 || error.statusCode === 422) &&
            attempt <= CONTEXT_EXCEEDED_RETRIES
          ) {
            const responseBody: string = error.responseBody ?? "";
            const errorMessage: string = error.message ?? "";
            const lowerBody: string = responseBody.toLowerCase();
            const lowerMsg: string = errorMessage.toLowerCase();

            const isContextError: boolean =
              lowerBody.includes("context") ||
              lowerMsg.includes("context size") ||
              lowerMsg.includes("token limit") ||
              lowerBody.includes("exceeded") ||
              lowerBody.includes("length") ||
              lowerMsg.includes("too long");

            if (isContextError) {
              this._logger.warn("Context size exceeded, triggering reactive compaction", {
                attempt,
                maxRetries: CONTEXT_EXCEEDED_RETRIES,
                statusCode: error.statusCode,
                responseBody: responseBody,
                errorMessage: errorMessage,
                currentTokenCount: this._totalInputTokens,
                contextWindow: this._contextWindow,
                utilization: `${((this._totalInputTokens / this._contextWindow) * 100).toFixed(1)}%`,
              });

              this._forceCompactionOnNextStep = true;
              continue;
            }
          }

          throw error;
        }

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

    const rawTools: ToolSet = {
      ...tools,
      ...(extraTools ?? {}),
      done: customDoneTool ?? doneTool,
    };

    // Enable tool result compaction to prevent oversized tool results from causing context overflow
    const allTools: ToolSet = wrapToolSetWithReasoning(rawTools, {
      enableResultCompaction: true,
      compactionOptions: {
        maxTokens: 2000,
        representativeArraySize: 5,
      },
      logger: this._logger,
    });

    /** Names of the base tools (always visible). */
    const baseToolNames: string[] = Object.keys({ ...tools, done: customDoneTool ?? doneTool });
    /** Names of extra (mode-gated) tools — registered but hidden by default. */
    const extraToolNames: string[] = Object.keys(extraTools ?? {});

    // Pre-compute the fixed token overhead that's included in every API request
    // but not in the messages array: system prompt + tool definitions.
    // This is critical for accurate context window tracking.
    const fixedOverheadTokens: number = _estimateFixedOverhead(instructions, allTools);
    self._fixedOverheadTokens = fixedOverheadTokens;
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
        // Memory diagnostics: log heap/RSS at every step to track leaks
        const mem = process.memoryUsage();
        logger.info("Memory usage at prepareStep", {
          stepNumber,
          messageCount: messages.length,
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
          externalMB: Math.round(mem.external / 1024 / 1024),
          arrayBuffersMB: Math.round(mem.arrayBuffers / 1024 / 1024),
        });

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
              };
            }
          }
        }

        // Detect duplicate tool calls (loop prevention) early to break
        // repeated non-productive tool loops with a forced think step.
        const duplicateDirective = getDuplicateToolCallDirective(stepNumber, messages);

        if (duplicateDirective) {
          logger.warn("Duplicate tool call detected — forcing think to break loop", {
            stepNumber,
            directive: JSON.stringify(duplicateDirective),
          });
          return duplicateDirective;
        }

        // Check for pause — await the promise if the agent has been paused
        const pausePromise: Promise<void> | null = getPausePromise ? getPausePromise() : null;

        if (pausePromise) {
          logger.info("Agent paused, waiting for resume...");
          await pausePromise;
          logger.info("Agent resumed.");
        }

        // Force done tool on last step
        if (stepNumber >= maxSteps - 1) {
          logger.warn("Agent reached max steps, forcing done tool", {
            stepNumber,
            maxSteps,
          });

          return {
            activeTools: ["done"] as (keyof typeof allTools)[],
          };
        }

        // Token-based history compaction: count message tokens + fixed overhead
        // (system prompt + tool definitions) for an accurate total.
        // Also account for the dynamic creation-mode prompt which is injected
        // into the system prompt on-the-fly but not counted in fixedOverheadTokens.
        const messageTokens: number = _countTokens(messages);

        const creationPrompt: string | null = (useExtraTools && getCreationModePrompt)
          ? getCreationModePrompt()
          : null;
        const dynamicOverheadTokens: number = creationPrompt
          ? fixedOverheadTokens + _countTextTokens(creationPrompt)
          : fixedOverheadTokens;

        const tokenCount: number = messageTokens + dynamicOverheadTokens;

        // Update status service with context info (including percentage for UI display)
        const statusService: StatusService = StatusService.getInstance();
        statusService.setContextTokensWithThreshold(tokenCount, compactionTokenThreshold, self._contextWindow);

        // Check if compaction is needed (predictive trigger with headroom)
        // Triggers earlier to leave room for the next turn/tool result
        const shouldCompact: boolean =
          tokenCount + COMPACTION_HEADROOM_TOKENS > compactionTokenThreshold ||
          self._forceCompactionOnNextStep;

        if (shouldCompact) {
          self._forceCompactionOnNextStep = false;

          logger.info("Compacting agent history", {
            tokenCount,
            messageTokens,
            fixedOverhead: fixedOverheadTokens,
            dynamicOverhead: dynamicOverheadTokens - fixedOverheadTokens,
            threshold: compactionTokenThreshold,
            messageCount: messages.length,
            forced: tokenCount <= compactionTokenThreshold,
          });

          // Use summary-only compaction (no truncation)
          const compactionTargetTokens: number = Math.max(
            1200,
            self._compactionTokenThreshold - fixedOverheadTokens - COMPACTION_HEADROOM_TOKENS,
          );

          const compactionResult = await compactMessagesSummaryOnlyAsync(
            messages,
            compactionModel,
            logger,
            compactionTargetTokens,
            (msgs: ModelMessage[]) => _countTokens(msgs) + fixedOverheadTokens,
          );

          logger.info("Summary-only compaction completed", {
            originalTokens: compactionResult.originalTokens,
            compactedTokens: compactionResult.compactedTokens,
            reduction: compactionResult.originalTokens - compactionResult.compactedTokens,
            passes: compactionResult.passes,
            converged: compactionResult.converged,
            finalMessageCount: compactionResult.messages.length,
          });

          return { messages: compactionResult.messages, activeTools: activeToolNames };
        }

        // When extra tools are active, inject the creation mode guide into the system prompt
        // and return activeTools so the LLM can see them; when not in creation mode and
        // there are no extra tools, return {} (no restriction).
        if (extraToolNames.length > 0) {
          if (creationPrompt) {
            return { system: `${instructions}\n\n${creationPrompt}`, activeTools: activeToolNames };
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

// Cached tokenizer to avoid recreating it on every call (saves ~23s per message)
let _cachedEncoder: ReturnType<typeof encodingForModel> | null = null;

function _getTextEncoder(): ReturnType<typeof encodingForModel> {
  if (!_cachedEncoder) {
    _cachedEncoder = encodingForModel("gpt-4o");
  }
  return _cachedEncoder;
}

/**
 * Count tokens in a plain text string using cl100k_base encoding.
 */
function _countTextTokens(text: string): number {
  return _getTextEncoder().encode(text).length;
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

  for (const [name, toolDef] of Object.entries(allTools)) {
    overhead += _countTextTokens(name) + 10;

    if (toolDef && typeof toolDef === "object") {
      const desc: unknown = (toolDef as Record<string, unknown>).description;
      if (typeof desc === "string") {
        overhead += _countTextTokens(desc);
      }

      const inputSchema: unknown = (toolDef as Record<string, unknown>).inputSchema;

      if (inputSchema) {
        let schemaStr: string;

        if (inputSchema instanceof z.ZodSchema) {
          const jsonSchema = zodToJsonSchema(inputSchema);
          schemaStr = JSON.stringify(jsonSchema);
        } else if (typeof inputSchema === "object") {
          schemaStr = JSON.stringify(inputSchema);
        } else {
          schemaStr = String(inputSchema);
        }

        overhead += _countTextTokens(schemaStr);
      }
    }
  }

  return overhead;
}

/**
 * Count tokens across all messages using cl100k_base encoding (GPT-4/Claude compatible).
 * This provides a reasonable approximation for most LLM providers.
 * Note: This counts message content plus JSON structure overhead, not system prompt or tool definitions.
 */
function _countTokens(messages: ModelMessage[]): number {
  const enc = _getTextEncoder();
  let totalTokens: number = 0;

  for (const msg of messages) {
    totalTokens += MESSAGE_JSON_OVERHEAD_TOKENS;

    const text: string = _extractTextContent(msg);
    totalTokens += enc.encode(text).length;
  }

  return totalTokens;
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
      } else if ("type" in part && part.type === "tool-call") {
        const toolCall = part as {
          toolCallId?: string;
          toolName?: string;
          args?: unknown;
          input?: unknown;
        };
        parts.push(JSON.stringify({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args ?? toolCall.input,
        }));
      } else if ("result" in part || "output" in part) {
        const resPart = part as {
          result?: unknown;
          output?: unknown;
          toolCallId?: string;
          isError?: boolean;
        };
        parts.push(JSON.stringify({
          toolCallId: resPart.toolCallId,
          result: resPart.result ?? resPart.output,
          isError: resPart.isError,
        }));
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
