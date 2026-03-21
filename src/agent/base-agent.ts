import {
  ToolLoopAgent,
  ToolSet,
  LanguageModel,
  hasToolCall,
  stepCountIs,
  type ModelMessage,
  type Tool,
} from "ai";

import { doneTool } from "../tools/done.tool.js";
import { LoggerService } from "../services/logger.service.js";
import { StatusService } from "../services/status.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import { getDuplicateToolCallDirective } from "../utils/prepare-step.js";
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { wrapToolSetWithReasoning } from "../utils/tool-reasoning-wrapper.js";
import { compactMessagesSummaryOnlyAsync } from "../utils/summarization-compaction.js";
import { isContextExceededApiError } from "../utils/context-error.js";
import { apply429BackoffAsync } from "../utils/rate-limit-retry.js";
import { extractAiErrorDetails } from "../utils/ai-error.js";
import {
  countTextTokens,
  countTokens,
  estimateFixedOverhead,
  estimateRequestLikeTokens,
  type IRequestLikeTokenEstimate,
} from "../utils/token-tracker.js";
import { extractLastAssistantToolCalls } from "../utils/tool-call-tracker.js";

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
 * How many times to wait and retry when receiving 429 rate limit errors.
 */
const MAX_429_RETRIES: number = 3;

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
  protected _shouldTerminateRunCallback: (() => boolean) | null;

  //#endregion Data members

  //#region Constructors

  protected constructor(options?: IBaseAgentOptions) {
    this._agent = null;
    this._logger = LoggerService.getInstance();
    this._initialized = false;
    this._maxSteps = options?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    this._contextWindow = options?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this._compactionTokenThreshold = Math.floor(this._contextWindow * COMPACTION_THRESHOLD_PERCENTAGE);
    this._shouldTerminateRunCallback = null;
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

      let _429Retries: number = 0;

      for (let attempt: number = 1; attempt <= AGENT_EMPTY_RESPONSE_RETRIES + 1; attempt++) {
        // Reset token count so prepareStep doesn't use stale values from a failed attempt
        this._totalInputTokens = 0;

        let result;

        try {
          result = await this._agent!.generate({ prompt: userMessage });
        } catch (error: unknown) {
          const currentAgentAttempt: number = attempt;
          const totalAgentAttempts: number = AGENT_EMPTY_RESPONSE_RETRIES + 1;
          const aiErrorDetails = extractAiErrorDetails(error);

          // Enhanced error logging for AI provider errors
          if (aiErrorDetails.statusCode !== null) {
            const responseBody: string | null = aiErrorDetails.responseBody;
            const responseBodyLength = responseBody?.length ?? 0;
            const responseBodyPreview = responseBody
              ? responseBody.substring(0, Math.min(1000, responseBodyLength)) +
                (responseBodyLength > 1000 ? "..." : "")
              : undefined;

            this._logger.error("AI provider API call failed", {
              attempt,
              agentAttempt: currentAgentAttempt,
              agentAttemptTotal: totalAgentAttempts,
              statusCode: aiErrorDetails.statusCode,
              message: aiErrorDetails.message,
              providerMessage: aiErrorDetails.providerMessage,
              provider: aiErrorDetails.provider,
              model: aiErrorDetails.model,
              responseBodyPreview,
              url: aiErrorDetails.url,
            });
          } else if (error instanceof Error) {
            this._logger.error("AI call failed with error", {
              attempt,
              agentAttempt: currentAgentAttempt,
              agentAttemptTotal: totalAgentAttempts,
              errorName: error.name,
              errorMessage: error.message,
              errorStack: error.stack?.split('\n').slice(0, 5).join('\n'),
            });
          } else {
            this._logger.error("AI call failed with unknown error", {
              attempt,
              agentAttempt: currentAgentAttempt,
              agentAttemptTotal: totalAgentAttempts,
              error: String(error),
            });
          }

          // Handle context exceeded errors with reactive compaction
          // Covers: 400 (hard gate), 500 (provider), 413/422 (other providers)
          if (
            isContextExceededApiError(error) &&
            attempt <= CONTEXT_EXCEEDED_RETRIES
          ) {
            const responseBody: string = aiErrorDetails.responseBody ?? "";
            const errorMessage: string = aiErrorDetails.providerMessage ?? aiErrorDetails.message;

            this._logger.warn("Context size exceeded, triggering reactive compaction", {
              attempt,
              agentAttempt: currentAgentAttempt,
              agentAttemptTotal: totalAgentAttempts,
              maxRetries: CONTEXT_EXCEEDED_RETRIES,
              statusCode: aiErrorDetails.statusCode,
              responseBody: responseBody,
              errorMessage: errorMessage,
              currentTokenCount: this._totalInputTokens,
              contextWindow: this._contextWindow,
              utilization: `${((this._totalInputTokens / this._contextWindow) * 100).toFixed(1)}%`,
            });

            this._forceCompactionOnNextStep = true;
            continue;
          }

          // Handle 429 rate limit errors with Retry-After wait
          if (aiErrorDetails.statusCode === 429) {
            if (_429Retries < MAX_429_RETRIES) {
              _429Retries++;
              await apply429BackoffAsync({
                logger: this._logger,
                error,
                retryAttempt: _429Retries,
                logMessage: "Rate limited (429) in agent loop, waiting before retry",
                logContext: {
                  attempt,
                  agentAttempt: currentAgentAttempt,
                  agentAttemptTotal: totalAgentAttempts,
                  _429Retries,
                  max429Retries: MAX_429_RETRIES,
                },
              });
              attempt--; // Don't burn the empty-response retry budget
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

        // External terminal conditions (e.g. create_table-triggered rebuild)
        // may intentionally end the current run without a done summary.
        if (this._shouldTerminateRunCallback && this._shouldTerminateRunCallback()) {
          this._logger.info("Current run terminated by external condition");
          return { text, stepsCount };
        }

        // If we got text, return immediately
        if (text.trim()) {
          this._logger.debug("Agent response generated", { stepsCount });
          return { text, stepsCount };
        }

        // Empty response — retry if we have attempts left
        if (attempt <= AGENT_EMPTY_RESPONSE_RETRIES) {
          this._logger.warn("Model returned empty response, retrying agent generate", {
            attempt,
            agentAttempt: attempt,
            agentAttemptTotal: AGENT_EMPTY_RESPONSE_RETRIES + 1,
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
    getAbortSignal?: () => AbortSignal | null,
    shouldTerminateRun?: () => boolean,
  ): void {
    this._shouldTerminateRunCallback = shouldTerminateRun ?? null;

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

    // Wrap tools with reasoning field augmentation and enforcement.
    const allTools: ToolSet = wrapToolSetWithReasoning(rawTools, {
      logger: this._logger,
    });

    /** Names of the base tools (always visible). */
    const baseToolNames: string[] = Object.keys({ ...tools, done: customDoneTool ?? doneTool });
    /** Names of extra (mode-gated) tools — registered but hidden by default. */
    const extraToolNames: string[] = Object.keys(extraTools ?? {});

    // Pre-compute the fixed token overhead that's included in every API request
    // but not in the messages array: system prompt + tool definitions.
    // This is critical for accurate context window tracking.
    const fixedOverheadTokens: number = estimateFixedOverhead(instructions, allTools);
    self._fixedOverheadTokens = fixedOverheadTokens;
    logger.debug("Computed fixed token overhead for context tracking", {
      systemPromptTokens: countTextTokens(instructions),
      toolCount: Object.keys(allTools).length,
      toolNames: Object.keys(allTools),
      totalOverhead: fixedOverheadTokens,
    });

    this._agent = new ToolLoopAgent({
      model,
      instructions,
      maxRetries: 0,
      tools: allTools,
      stopWhen: [
        hasToolCall("done"),
        stepCountIs(maxSteps),
        (): boolean => {
          if (!shouldTerminateRun) {
            return false;
          }

          const terminateRun: boolean = shouldTerminateRun();
          if (terminateRun) {
            logger.info("Terminal run-stop condition detected, ending current generate run");
          }

          return terminateRun;
        },
      ],
      experimental_repairToolCall: repairToolCallJsonAsync,
      prepareStep: async ({ stepNumber, messages }) => {
        // Early abort check: if the abort signal is already fired, throw immediately.
        // This prevents wasted work during compaction, pause-waiting, or tool execution
        // when /cancel has been called.
        const abortSignal: AbortSignal | null = getAbortSignal ? getAbortSignal() : null;
        if (abortSignal?.aborted) {
          throw Object.assign(new Error("Operation was stopped."), { name: "AbortError" });
        }

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
          const toolCalls: IToolCallSummary[] = extractLastAssistantToolCalls(messages);

          logger.debug("prepareStep onStep callback payload", {
            stepNumber,
            messageCount: messages.length,
            toolCallsCount: toolCalls.length,
            toolNames: toolCalls.map((toolCall: IToolCallSummary): string => toolCall.name),
          });

          try {
            await onStepAsync(stepNumber, toolCalls);
          } catch (callbackError: unknown) {
            logger.warn("onStep callback failed in prepareStep", {
              stepNumber,
              error: callbackError instanceof Error ? callbackError.message : String(callbackError),
            });
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
        const hasDuplicateToolLoop: boolean = getDuplicateToolCallDirective(stepNumber, messages);

        if (hasDuplicateToolLoop) {
          logger.warn("Duplicate tool call pattern detected, restricting to think + done", {
            stepNumber,
            action: "restrict_tools",
          });

          return {
            activeTools: ["think", "done"] as (keyof typeof allTools)[],
          };
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

        // Token-based history compaction using request-style token estimation
        // as the primary source of truth, with legacy estimation as fallback.
        const legacyMessageTokens: number = countTokens(messages);

        const creationPrompt: string | null = (useExtraTools && getCreationModePrompt)
          ? getCreationModePrompt()
          : null;
        const legacyDynamicOverheadTokens: number = creationPrompt
          ? fixedOverheadTokens + countTextTokens(creationPrompt)
          : fixedOverheadTokens;
        const legacyTokenCount: number = legacyMessageTokens + legacyDynamicOverheadTokens;

        const requestEstimate: IRequestLikeTokenEstimate | null = estimateRequestLikeTokens(
          messages,
          instructions,
          creationPrompt,
          allTools,
          activeToolNames,
        );

        const tokenCount: number = requestEstimate?.breakdown.total ?? legacyTokenCount;
        const estimationSource: "request" | "fallback" = requestEstimate ? "request" : "fallback";

        // Keep a consistent internal token estimate for fallback/error diagnostics.
        self._totalInputTokens = tokenCount;

        // Update status service with context info (including percentage for UI display)
        const statusService: StatusService = StatusService.getInstance();
        statusService.setContextTokensWithThreshold(tokenCount, compactionTokenThreshold, self._contextWindow);

        // Check if compaction is needed (predictive trigger with headroom)
        // Triggers earlier to leave room for the next turn/tool result
        const shouldCompact: boolean =
          tokenCount + COMPACTION_HEADROOM_TOKENS > compactionTokenThreshold ||
          self._forceCompactionOnNextStep;

        if (shouldCompact) {
          const forcedCompaction: boolean = self._forceCompactionOnNextStep;
          self._forceCompactionOnNextStep = false;

          logger.info("Compacting agent history", {
            tokenCount,
            messageTokens: requestEstimate?.breakdown.messages ?? legacyMessageTokens,
            fixedOverhead: fixedOverheadTokens,
            dynamicOverhead: legacyDynamicOverheadTokens - fixedOverheadTokens,
            threshold: compactionTokenThreshold,
            messageCount: messages.length,
            forced: forcedCompaction,
            estimationSource,
            requestTokenBreakdown: requestEstimate?.breakdown,
            fallbackTokenEstimate: requestEstimate ? legacyTokenCount : undefined,
          });

          // Use summary-only compaction (no truncation)
          const compactionTargetTokens: number = Math.max(
            1200,
            self._compactionTokenThreshold - COMPACTION_HEADROOM_TOKENS,
          );

          const compactionResult = await compactMessagesSummaryOnlyAsync(
            messages,
            compactionModel,
            logger,
            compactionTargetTokens,
            (msgs: ModelMessage[]) => {
              const estimate: IRequestLikeTokenEstimate | null = estimateRequestLikeTokens(
                msgs,
                instructions,
                creationPrompt,
                allTools,
                activeToolNames,
              );

              if (estimate) {
                return estimate.breakdown.total;
              }

              return countTokens(msgs) + legacyDynamicOverheadTokens;
            },
            forcedCompaction,
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

//#endregion Private functions
