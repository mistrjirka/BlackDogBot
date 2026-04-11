import {
  ToolLoopAgent,
  ToolSet,
  LanguageModel,
  stepCountIs,
  type ModelMessage,
} from "ai";

import { LoggerService } from "../services/logger.service.js";
import { StatusService } from "../services/status.service.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
import {
  getDuplicateToolCallLoopInfo,
  type IDuplicateToolCallLoopInfo,
} from "../utils/prepare-step.js";

export type { IDuplicateToolCallLoopInfo };
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { wrapToolSetWithReasoning } from "../utils/tool-reasoning-wrapper.js";
import { compactMessagesSummaryOnlyAsync } from "../utils/summarization-compaction.js";
import {
  getConnectionRetryDelayMs,
  getDisableThinkingOnRetry,
  isConnectionError,
  isContextExceededApiError,
  isLlamaCppParseError,
  isRetryableApiError,
  MAX_CONNECTION_RETRIES,
} from "../utils/context-error.js";
import { apply429BackoffAsync } from "../utils/rate-limit-retry.js";
import { extractAiErrorDetails } from "../utils/ai-error.js";
import {
  countTokens,
  estimateRequestLikeTokens,
  estimateRequestLikeTokensByBytes,
  type IRequestLikeTokenEstimate,
  type IRequestLikeByteTokenEstimate,
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
const MAX_429_RETRIES: number = 8;

/**
 * How many times to retry transient non-429 provider errors
 * (e.g., invalid JSON provider responses on unstable models).
 */
const MAX_GENERIC_RETRIES: number = 3;

/**
 * Token budget reserved for predictive compaction headroom.
 * Compaction triggers earlier by this amount to leave room for the next turn.
 */
const COMPACTION_HEADROOM_TOKENS: number = 4000;

/**
 * Initial safety factor applied to local token estimates.
 * This intentionally overestimates slightly to reduce hard-gate misses.
 */
const INITIAL_TOKEN_ESTIMATE_CORRECTION_FACTOR: number = 1.08;

/**
 * Maximum correction factor when calibrating estimates against provider usage.
 */
const MAX_TOKEN_ESTIMATE_CORRECTION_FACTOR: number = 1.80;

/**
 * Exponential moving average weight for token-estimate calibration updates.
 */
const TOKEN_ESTIMATE_CORRECTION_WEIGHT: number = 0.30;

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

/**
 * Error thrown when duplicate tool call escalation exhausts all attempts
 * and the model cannot break out of a loop.
 */
export class DuplicateToolLoopHardStopError extends Error {
  public readonly loopInfo: IDuplicateToolCallLoopInfo;

  constructor(loopInfo: IDuplicateToolCallLoopInfo) {
    super(`Duplicate tool call loop hard stop: ${loopInfo.summaryString}`);
    this.name = "DuplicateToolLoopHardStopError";
    this.loopInfo = loopInfo;
  }
}

/**
 * Result of a duplicate tool call loop escalation callback.
 */
export enum EDuplicateLoopAction {
  /** Force the model to call the think tool to break the loop. */
  ForceThink = "force_think",
  /** Allow normal tool execution to continue. */
  Continue = "continue",
  /** Throw a hard-stop error to terminate the run. */
  HardStop = "hard_stop",
}

/**
 * Callback invoked when a duplicate tool call loop is detected.
 * Receives the loop info and returns an action to take.
 */
export type OnDuplicateToolLoopCallback = (
  loopInfo: IDuplicateToolCallLoopInfo,
  stepNumber: number,
  messages: ModelMessage[],
) => Promise<EDuplicateLoopAction>;

export interface IBaseAgentOptions {
  maxSteps?: number;
  contextWindow?: number;
  onDuplicateToolLoop?: OnDuplicateToolLoopCallback;
}

//#endregion Interfaces

//#region BaseAgent

export abstract class BaseAgentBase {
  //#region Data members

  protected _agent: ToolLoopAgent | null;
  protected _agentWithThinkingDisabled: ToolLoopAgent | null;
  protected _logger: LoggerService;
  protected _initialized: boolean;
  protected _maxSteps: number;
  protected _contextWindow: number;
  protected _compactionTokenThreshold: number;
  protected _totalInputTokens: number = 0;
  protected _forceCompactionOnNextStep: boolean = false;
  protected _tokenEstimateCorrectionFactor: number;
  protected _lastPrepareStepEstimatedTokens: number | null;
  protected _estimatedInputTokens: number = 0;
  protected _providerInputTokens: number | null = null;
  protected _rawEstimatedInputTokens: number = 0;
  protected _shouldTerminateRunCallback: (() => boolean) | null;
  protected _onDuplicateToolLoop: OnDuplicateToolLoopCallback | null;

  //#endregion Data members

  //#region Constructors

  protected constructor(options?: IBaseAgentOptions) {
    this._agent = null;
    this._agentWithThinkingDisabled = null;
    this._logger = LoggerService.getInstance();
    this._initialized = false;
    this._maxSteps = options?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    this._contextWindow = options?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this._compactionTokenThreshold = Math.floor(this._contextWindow * COMPACTION_THRESHOLD_PERCENTAGE);
    this._tokenEstimateCorrectionFactor = INITIAL_TOKEN_ESTIMATE_CORRECTION_FACTOR;
    this._lastPrepareStepEstimatedTokens = null;
    this._shouldTerminateRunCallback = null;
    this._onDuplicateToolLoop = options?.onDuplicateToolLoop ?? null;
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
      let _genericRetries: number = 0;
      let contextRetries: number = 0;
      let aggressiveContextRecoveryUsed: boolean = false;
      let parseRetryAttempt: boolean = false;
      let useDisableThinking: boolean = false;

      for (let attempt: number = 1; attempt <= AGENT_EMPTY_RESPONSE_RETRIES + 1; attempt++) {
        // Reset token count so prepareStep doesn't use stale values from a failed attempt
        this._totalInputTokens = 0;
        this._lastPrepareStepEstimatedTokens = null;

        let result;

        const currentAgent: ToolLoopAgent | null = useDisableThinking
          ? this._agentWithThinkingDisabled
          : this._agent;

        if (!currentAgent) {
          this._logger.error("No agent available for generation", {
            useDisableThinking,
            parseRetryAttempt,
          });
          throw new Error("Agent not available for generation");
        }

        try {
          result = await currentAgent.generate({ prompt: userMessage });
        } catch (error: unknown) {
          const currentAgentAttempt: number = attempt;
          const totalAgentAttempts: number = AGENT_EMPTY_RESPONSE_RETRIES + 1;
          const aiErrorDetails = extractAiErrorDetails(error);
          const isRetriable429: boolean =
            aiErrorDetails.statusCode === 429 &&
            _429Retries < MAX_429_RETRIES;

          // Handle context exceeded errors with reactive compaction
          // Covers: 400 (hard gate), 500 (provider), 413/422 (other providers)
          if (
            isContextExceededApiError(error) &&
            contextRetries < CONTEXT_EXCEEDED_RETRIES
          ) {
            contextRetries++;
            const responseBody: string = aiErrorDetails.responseBody ?? "";
            const errorMessage: string = aiErrorDetails.providerMessage ?? aiErrorDetails.message;

            this._logger.warn("Context size exceeded, triggering reactive compaction", {
              attempt,
              agentAttempt: currentAgentAttempt,
              agentAttemptTotal: totalAgentAttempts,
              contextRetry: contextRetries,
              maxRetries: CONTEXT_EXCEEDED_RETRIES,
              statusCode: aiErrorDetails.statusCode,
              responseBody: responseBody,
              errorMessage: errorMessage,
              rawEstimatedInputTokens: this._rawEstimatedInputTokens,
              estimatedInputTokens: this._estimatedInputTokens,
              providerInputTokens: this._providerInputTokens,
              contextWindow: this._contextWindow,
              utilization: `${((this._providerInputTokens ?? this._estimatedInputTokens) / this._contextWindow * 100).toFixed(1)}%`,
            });

            this._forceCompactionOnNextStep = true;
            attempt--; // Do not burn empty-response retry budget for context recovery
            continue;
          }

          if (isContextExceededApiError(error) && !aggressiveContextRecoveryUsed) {
            aggressiveContextRecoveryUsed = true;
            this._logger.warn("Context size exceeded after reactive retries, forcing aggressive compaction", {
              attempt,
              agentAttempt: currentAgentAttempt,
              agentAttemptTotal: totalAgentAttempts,
              contextRetries,
              maxRetries: CONTEXT_EXCEEDED_RETRIES,
              statusCode: aiErrorDetails.statusCode,
              correctionFactor: this._tokenEstimateCorrectionFactor,
            });

            this._forceCompactionOnNextStep = true;
            attempt--; // Give compaction one final chance before terminal failure
            continue;
          }

          if (isLlamaCppParseError(error) && !parseRetryAttempt) {
            const disableThinking: boolean = getDisableThinkingOnRetry();
            if (disableThinking && this._agentWithThinkingDisabled) {
              parseRetryAttempt = true;
              useDisableThinking = true;
              this._logger.warn("llama.cpp parse error detected, retrying with thinking disabled", {
                attempt,
                agentAttempt: currentAgentAttempt,
                agentAttemptTotal: totalAgentAttempts,
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
          }

          // Handle 429 rate limit errors with Retry-After wait
          if (isRetriable429) {
            _429Retries++;
            await apply429BackoffAsync({
              logger: this._logger,
              error,
              retryAttempt: _429Retries,
              logMessage: "Rate limited (429) in agent loop, waiting before retry",
              logContext: {
                attempt,
                emptyResponseAttempt: attempt,
                agentAttempt: currentAgentAttempt,
                agentAttemptTotal: totalAgentAttempts,
                _429Retries,
                current429RetryCount: _429Retries,
                max429Retries: MAX_429_RETRIES,
              },
            });
            attempt--; // Don't burn the empty-response retry budget
            continue;
          }

          const isConnectionRelatedError: boolean = isConnectionError(error);
          const maxGenericRetries: number = isConnectionRelatedError
            ? MAX_CONNECTION_RETRIES
            : MAX_GENERIC_RETRIES;

          if (isRetryableApiError(error) && _genericRetries < maxGenericRetries) {
            _genericRetries++;
            const retryDelayMs: number = isConnectionRelatedError
              ? getConnectionRetryDelayMs(_genericRetries)
              : 0;
            this._logger.warn("Retryable API error in agent loop, retrying", {
              attempt,
              emptyResponseAttempt: attempt,
              agentAttempt: currentAgentAttempt,
              agentAttemptTotal: totalAgentAttempts,
              genericRetryCount: _genericRetries,
              maxGenericRetries,
              retryType: isConnectionRelatedError ? "connection" : "generic",
              retryDelayMs,
              statusCode: aiErrorDetails.statusCode,
              provider: aiErrorDetails.provider,
              model: aiErrorDetails.model,
              message: aiErrorDetails.message,
              providerMessage: aiErrorDetails.providerMessage,
            });

            if (retryDelayMs > 0) {
              await new Promise<void>((resolve: () => void): void => {
                setTimeout(resolve, retryDelayMs);
              });
            }

            attempt--; // Don't burn the empty-response retry budget
            continue;
          }

          // Enhanced error logging for terminal errors only.
          // Suppress noisy per-attempt error logs for retriable 429s.
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

          throw error;
        }

        let text: string = result.text ?? "";

        // Track API-reported token usage
        const inputTokens = result.totalUsage?.inputTokens ?? result.usage?.inputTokens;
        if (inputTokens !== undefined) {
          this._totalInputTokens = inputTokens;
          this._providerInputTokens = inputTokens ?? null;
        } else {
          this._totalInputTokens = 0;
          this._providerInputTokens = null;
          this._logger.warn("Token usage missing from LLM response; using tiktoken fallback.");
        }

        const stepsCount: number = result.steps?.length ?? 1;

        // External terminal conditions (e.g. create_table-triggered rebuild)
        // may intentionally end the current run without final output text.
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
    getExtraTools?: () => ToolSet | null,
    extraTools?: ToolSet,
    getPausePromise?: () => Promise<void> | null,
    getCreationModePrompt?: () => string | null,
    getAbortSignal?: () => AbortSignal | null,
    shouldTerminateRun?: () => boolean,
    onDuplicateToolLoop?: OnDuplicateToolLoopCallback | null,
  ): void {
    this._shouldTerminateRunCallback = shouldTerminateRun ?? null;
    const effectiveDuplicateCallback: OnDuplicateToolLoopCallback | null =
      onDuplicateToolLoop ?? this._onDuplicateToolLoop;

    const self = this; // Capture this for use in callbacks
    const maxSteps: number = this._maxSteps;
    const compactionTokenThreshold: number = this._compactionTokenThreshold;
    const logger: LoggerService = this._logger;
    const compactionModel: LanguageModel = model;

    const rawTools: ToolSet = {
      ...tools,
      ...(extraTools ?? {}),
    };

    // Wrap tools with optional reasoning field augmentation.
    const allTools: ToolSet = wrapToolSetWithReasoning(rawTools, {
      logger: this._logger,
    });

    /** Names of the base tools (always visible). */
    const baseToolNames: string[] = Object.keys(tools);
    /** Names of extra (mode-gated) tools — registered but hidden by default. */
    const extraToolNames: string[] = Object.keys(extraTools ?? {});

    this._agent = new ToolLoopAgent({
      model,
      instructions,
      maxRetries: 0,
      tools: allTools,
      stopWhen: [
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
      prepareStep: async ({ stepNumber, messages, steps }) => {
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

        // Detect duplicate tool calls (loop prevention) early to break
        // repeated non-productive tool loops with a forced think step.
        const loopInfo: IDuplicateToolCallLoopInfo = getDuplicateToolCallLoopInfo(stepNumber, messages);

        if (loopInfo.isLoopDetected) {
          if (effectiveDuplicateCallback) {
            const action: EDuplicateLoopAction = await effectiveDuplicateCallback(loopInfo, stepNumber, messages);

            if (action === EDuplicateLoopAction.HardStop) {
              throw new DuplicateToolLoopHardStopError(loopInfo);
            }

            if (action === EDuplicateLoopAction.ForceThink) {
              logger.warn("Duplicate tool call pattern detected, restricting to think", {
                stepNumber,
                action: "restrict_tools",
                loopInfo: loopInfo.summaryString,
              });

              return {
                activeTools: ["think"] as (keyof typeof allTools)[],
              };
            }

            // EDuplicateLoopAction.Continue — fall through to allow normal tools
            logger.info("Duplicate tool call pattern detected, continuing with normal tools via callback", {
              stepNumber,
              action: "continue",
              loopInfo: loopInfo.summaryString,
            });
          } else {
            // Fallback to legacy behavior when no callback is provided
            logger.warn("Duplicate tool call pattern detected, restricting to think", {
              stepNumber,
              action: "restrict_tools",
              loopInfo: loopInfo.summaryString,
            });

            return {
              activeTools: ["think"] as (keyof typeof allTools)[],
            };
          }
        }

        // Check for pause — await the promise if the agent has been paused
        const pausePromise: Promise<void> | null = getPausePromise ? getPausePromise() : null;

        if (pausePromise) {
          logger.info("Agent paused, waiting for resume...");
          await pausePromise;
          logger.info("Agent resumed.");
        }

        // Token-based history compaction:
        // Recalculate request-size estimate on every step so long multi-step runs
        // do not keep stale token counts between steps.
        const lastStepActualInputTokens: number | undefined = stepNumber > 0
          ? steps.at(-1)?.usage?.inputTokens
          : undefined;
        if (
          typeof lastStepActualInputTokens === "number" &&
          lastStepActualInputTokens > 0 &&
          self._lastPrepareStepEstimatedTokens !== null &&
          self._lastPrepareStepEstimatedTokens > 0
        ) {
          const observedRatio: number = lastStepActualInputTokens / self._lastPrepareStepEstimatedTokens;
          const boundedRatio: number = Math.min(
            MAX_TOKEN_ESTIMATE_CORRECTION_FACTOR,
            Math.max(1.0, observedRatio),
          );
          const previousFactor: number = self._tokenEstimateCorrectionFactor;
          self._tokenEstimateCorrectionFactor = Math.min(
            MAX_TOKEN_ESTIMATE_CORRECTION_FACTOR,
            Math.max(
              1.0,
              previousFactor * (1 - TOKEN_ESTIMATE_CORRECTION_WEIGHT) + boundedRatio * TOKEN_ESTIMATE_CORRECTION_WEIGHT,
            ),
          );

          logger.info("Token estimate correction updated from provider usage", {
            stepNumber,
            previousEstimatedTokens: self._lastPrepareStepEstimatedTokens,
            previousActualTokens: lastStepActualInputTokens,
            observedRatio,
            previousFactor,
            updatedFactor: self._tokenEstimateCorrectionFactor,
          });
        }

        const creationPrompt: string | null = (useExtraTools && getCreationModePrompt)
          ? getCreationModePrompt()
          : null;
        const preciseRequestEstimate: IRequestLikeTokenEstimate | null = estimateRequestLikeTokens(
          messages,
          instructions,
          creationPrompt,
          allTools,
          activeToolNames,
        );
        const requestEstimate: IRequestLikeByteTokenEstimate | null = estimateRequestLikeTokensByBytes(
          messages,
          instructions,
          creationPrompt,
          allTools,
          activeToolNames,
        );
        const rawTokenEstimate: number =
          preciseRequestEstimate?.breakdown.total ??
          requestEstimate?.estimatedTokens ??
          countTokens(messages);
        self._lastPrepareStepEstimatedTokens = rawTokenEstimate;
        self._rawEstimatedInputTokens = rawTokenEstimate;

        const tokenCount: number = Math.ceil(rawTokenEstimate * self._tokenEstimateCorrectionFactor);
        self._estimatedInputTokens = tokenCount;
        const estimationSource: "tiktoken_request_body" | "bytes_fallback" | "tiktoken_messages_only" =
          preciseRequestEstimate
            ? "tiktoken_request_body"
            : requestEstimate
              ? "bytes_fallback"
              : "tiktoken_messages_only";

        // Keep a consistent internal token estimate for fallback/error diagnostics.
        self._totalInputTokens = tokenCount;

        // Message-only token count (what compaction can actually reduce)
        const messageTokensEstimated = countTokens(messages);

        // Fixed overhead that compaction cannot reduce (tools + system + JSON structure)
        const fixedOverheadTokens = Math.max(0, tokenCount - messageTokensEstimated);

        // Soft threshold based on compactable budget only
        const compactableThreshold = Math.max(1200, compactionTokenThreshold - COMPACTION_HEADROOM_TOKENS);

        // Only trigger soft compaction when message tokens exceed compactable budget
        const messageBasedSoftTrigger = messageTokensEstimated > compactableThreshold;

        // Update status service with context info (including percentage for UI display)
        const statusService: StatusService = StatusService.getInstance();
        statusService.setContextTokensWithThreshold(tokenCount, compactionTokenThreshold, self._contextWindow);

        // Check if compaction is needed (predictive trigger with headroom)
        // Triggers earlier to leave room for the next turn/tool result
        const hardLimit: number = Math.floor(self._contextWindow * HARD_GATE_THRESHOLD_PERCENTAGE);
        const exceedsHardLimitEstimate: boolean = tokenCount > hardLimit;
        const shouldCompact: boolean =
          exceedsHardLimitEstimate || // Hard limit still uses full request estimate
          messageBasedSoftTrigger ||  // Soft trigger uses message-only budget
          self._forceCompactionOnNextStep;

        if (shouldCompact) {
          const forcedCompaction: boolean = self._forceCompactionOnNextStep;
          self._forceCompactionOnNextStep = false;
          const aggressiveCompaction: boolean = exceedsHardLimitEstimate;

          logger.info("Compacting agent history", {
            tokenCount,
            messageTokensEstimated,
            fixedOverheadTokens,
            compactableThreshold,
            threshold: compactionTokenThreshold,
            messageBasedSoftTrigger,
            hardLimit,
            exceedsHardLimitEstimate,
            messageCount: messages.length,
            forced: forcedCompaction,
            aggressiveCompaction,
            correctionFactor: self._tokenEstimateCorrectionFactor,
            estimationSource,
            rawEstimatedInputTokens: self._rawEstimatedInputTokens,
            estimatedInputTokens: self._estimatedInputTokens,
            providerInputTokens: this._providerInputTokens,
          });

          // Use summary-only compaction (no truncation)
          const compactionTargetTokens: number = aggressiveCompaction
            ? Math.max(1200, Math.floor(self._contextWindow * 0.30))
            : Math.max(1200, Math.floor(self._contextWindow * 0.40));

          const compactionResult = await compactMessagesSummaryOnlyAsync(
            messages,
            compactionModel,
            logger,
            compactionTargetTokens,
            (msgs: ModelMessage[]): number => countTokens(msgs),
            forcedCompaction || aggressiveCompaction,
          );

          logger.info("Summary-only compaction completed", {
            originalTokens: compactionResult.originalTokens,
            compactedTokens: compactionResult.compactedTokens,
            reduction: compactionResult.originalTokens - compactionResult.compactedTokens,
            passes: compactionResult.passes,
            converged: compactionResult.converged,
            finalMessageCount: compactionResult.messages.length,
          });

          const postMessageTokensEstimated = countTokens(compactionResult.messages);
          logger.info("Post-compaction message budget check", {
            postMessageTokensEstimated,
            postCompactableThreshold: compactableThreshold,
            stillAboveCompactableThreshold: postMessageTokensEstimated > compactableThreshold,
          });

          const postCompactionEstimate: IRequestLikeByteTokenEstimate | null = estimateRequestLikeTokensByBytes(
            compactionResult.messages,
            instructions,
            creationPrompt,
            allTools,
            activeToolNames,
          );
          const postCompactionPreciseEstimate: IRequestLikeTokenEstimate | null = estimateRequestLikeTokens(
            compactionResult.messages,
            instructions,
            creationPrompt,
            allTools,
            activeToolNames,
          );
          const postCompactionRawTokenCount: number =
            postCompactionPreciseEstimate?.breakdown.total ??
            postCompactionEstimate?.estimatedTokens ??
            countTokens(compactionResult.messages);
          self._lastPrepareStepEstimatedTokens = postCompactionRawTokenCount;

          const postCompactionTokenCount: number = Math.ceil(
            postCompactionRawTokenCount * self._tokenEstimateCorrectionFactor,
          );
          self._totalInputTokens = postCompactionTokenCount;
          statusService.setContextTokensWithThreshold(
            postCompactionTokenCount,
            compactionTokenThreshold,
            self._contextWindow,
          );

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

  public setAgentWithThinkingDisabled(agent: ToolLoopAgent): void {
    if (this._agentWithThinkingDisabled) {
      this._logger.warn("Agent with thinking disabled already set, overwriting");
    }
    this._agentWithThinkingDisabled = agent;
  }

  //#endregion Protected methods

  protected get _currentInputTokensForLegacyLogs(): number {
    return this._providerInputTokens ?? this._estimatedInputTokens;
  }
}
//#endregion BaseAgent

//#region Private functions

//#endregion Private functions
