import { generateText, Output, dynamicTool, type LanguageModel } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { z } from "zod";
import { randomUUID } from "node:crypto";

import { LoggerService } from "../services/logger.service.js";
import { RateLimiterService } from "../services/rate-limiter.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { StatusService } from "../services/status.service.js";
import { extractAiErrorDetails, formatAiErrorForLog } from "./ai-error.js";
import { getConnectionRetryDelayMs, isConnectionError } from "./context-error.js";
import { apply429BackoffAsync } from "./rate-limit-retry.js";
import { runWithLlmCallTypeAsync } from "./llm-call-context.js";

//#region Types

export type LlmCallType = "agent_primary" | "summarization" | "schema_extraction" | "cron_history" | "job_execution";

export interface ILlmRetryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  callType?: LlmCallType;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120000; // 120 seconds

// Policy defaults per call type
const CALL_TYPE_POLICY: Record<LlmCallType, { maxAttempts: number; timeoutMs: number }> = {
  agent_primary: { maxAttempts: 3, timeoutMs: 120000 },
  summarization: { maxAttempts: 2, timeoutMs: 600000 },
  schema_extraction: { maxAttempts: 2, timeoutMs: 60000 },
  cron_history: { maxAttempts: 1, timeoutMs: 30000 },
  job_execution: { maxAttempts: 2, timeoutMs: 60000 },
};

//#endregion Types

//#region Interfaces

export interface IGenerateTextOptions {
  model: LanguageModel;
  prompt: string;
  system?: string;
  retryOptions?: ILlmRetryOptions;
}

export interface IGenerateObjectOptions<T extends z.ZodType> {
  model: LanguageModel;
  prompt: string;
  schema: T;
  system?: string;
  retryOptions?: ILlmRetryOptions;
}

//#endregion Interfaces

//#region Private Helpers

function getRetryPolicy(callType?: LlmCallType): { maxAttempts: number; timeoutMs: number } {
  if (callType && CALL_TYPE_POLICY[callType]) {
    return CALL_TYPE_POLICY[callType];
  }
  return { maxAttempts: DEFAULT_MAX_ATTEMPTS, timeoutMs: DEFAULT_TIMEOUT_MS };
}

function createLinkedAbortSignal(
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (!abortSignal && timeoutMs === Infinity) {
    return undefined;
  }

  const controller = new AbortController();

  const abortFn = (): void => {
    controller.abort();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
      return controller.signal;
    }
    abortSignal.addEventListener("abort", abortFn);
  }

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  // Clean up when signal aborts
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timeoutId);
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortFn);
    }
  });

  return controller.signal;
}

function tryParseJsonFromText(text: string): unknown | null {
  const trimmedText: string = text.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const candidates: string[] = [trimmedText];

  const fencedMatch: RegExpMatchArray | null = trimmedText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const firstBraceIndex: number = trimmedText.indexOf("{");
  const lastBraceIndex: number = trimmedText.lastIndexOf("}");
  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    candidates.push(trimmedText.slice(firstBraceIndex, lastBraceIndex + 1));
  }

  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.length === 0 || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Continue trying candidates.
    }
  }

  return null;
}

function estimateTokensFromTextByBytes(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function estimateTokensFromPromptAndSystem(prompt: string, system?: string): number {
  const promptBytes: number = Buffer.byteLength(prompt, "utf8");
  const systemBytes: number = system ? Buffer.byteLength(system, "utf8") : 0;
  return Math.ceil((promptBytes + systemBytes) / 4);
}

//#endregion Private Helpers

//#region Public functions

export async function generateTextWithRetryAsync(
  options: IGenerateTextOptions,
): Promise<{ text: string }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  const providerKey: string = AiProviderService.getInstance().getActiveProvider();

  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "agent_primary";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = retryOptions.timeoutMs ?? policy.timeoutMs;

  const llmCallId = randomUUID();
  let lastError: unknown;

  // Count input tokens for status display
  const inputTokensEstimate: number = estimateTokensFromPromptAndSystem(options.prompt, options.system);

  // Set status (in-flight)
  statusService.beginInFlight("llm_request", "Waiting for response", {
    inputTokens: inputTokensEstimate,
    inputTokensSource: "estimate_bytes",
    callType,
    llmCallId,
  });

  try {
    for (let attempt: number = 1; attempt <= maxAttempts; attempt++) {
      try {
        const linkedSignal = createLinkedAbortSignal(retryOptions.abortSignal, timeoutMs);

        const callFn = async (): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
          const result = await generateText({
            model: options.model,
            prompt: options.prompt,
            ...(options.system ? { system: options.system } : {}),
            maxRetries: 0, // Disable SDK retries - we manage retries ourselves
            abortSignal: linkedSignal,
          });

          const inputTokens: number =
            result.totalUsage?.inputTokens ??
            result.usage?.inputTokens ??
            inputTokensEstimate;
          const outputTokens: number =
            result.totalUsage?.outputTokens ??
            result.usage?.outputTokens ??
            estimateTokensFromTextByBytes(result.text ?? "");

          return {
            text: result.text ?? "",
            inputTokens,
            outputTokens,
          };
        };

        // NOTE: Do not schedule with RateLimiterService here.
        // Models from AiProviderService are already wrapped with limiter scheduling
        // in AiProviderService._wrapModelWithRateLimiter(). Scheduling again here
        // creates nested Bottleneck scheduling and can deadlock at maxConcurrent=1.
        const result: { text: string; inputTokens: number; outputTokens: number } =
          await runWithLlmCallTypeAsync(callType, callFn);

        // Record token usage for budget tracking (actual usage if available)
        rateLimiterService.recordTokenUsage(providerKey, result.inputTokens, result.outputTokens);

        logger.info("LLM call succeeded", {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          inputTokensEstimate,
          inputTokensActual: result.inputTokens,
          outputTokensActual: result.outputTokens,
          sdkRetriesDisabled: true,
        });

        return { text: result.text };
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));

        // Check if this was an abort (cancellation or timeout)
        const isAbort = error instanceof Error && error.name === "AbortError";

        logger.warn("LLM call failed" + (isAbort ? " (aborted)" : ""), {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          localRetryAttempt: attempt,
          localRetryTotal: maxAttempts,
          retryLayer: "local",
          sdkRetriesDisabled: true,
          error: errorMessage,
          isAbort,
        });

        // Update status with retry info
        statusService.setStatus("llm_request", `Retrying (${attempt}/${maxAttempts})`, {
          inputTokens: inputTokensEstimate,
          inputTokensSource: "estimate_bytes",
          callType,
          llmCallId,
          error: errorMessage,
        });

        // Don't retry on abort (cancellation or timeout)
        if (isAbort) {
          break;
        }

        if (extractAiErrorDetails(error).statusCode === 429) {
          await apply429BackoffAsync({
            logger,
            error,
            retryAttempt: attempt,
            logMessage: "LLM call rate limited (429), waiting before retry",
            logContext: {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
            },
          });
        } else {
          const isConnectionRelatedError: boolean = isConnectionError(error);
          if (isConnectionRelatedError) {
            const retryDelayMs: number = getConnectionRetryDelayMs(attempt);
            logger.warn("LLM call connection error, waiting before retry", {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
              retryDelayMs,
              retryType: "connection",
            });

            await new Promise<void>((resolve: () => void): void => {
              setTimeout(resolve, retryDelayMs);
            });
          }
        }
      }
    }
  } finally {
    statusService.endInFlight();
  }

  const finalErrorMsg = lastError instanceof Error
    ? lastError.message
    : String(lastError ?? "Unknown error");

  logger.error("LLM call failed after all retries", {
    llmCallId,
    callType,
    maxAttempts,
    localRetryTotal: maxAttempts,
    retryLayer: "local",
    sdkRetriesDisabled: true,
    error: finalErrorMsg,
  });

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM call failed after ${maxAttempts} retries: ${finalErrorMsg}`);
}

/**
 * Generates structured output using generateText + Output.object() with retry logic
 * and rate limiting. Guarantees valid JSON matching the provided Zod schema.
 *
 * Uses generateText with Output.object() instead of generateObject — this extracts
 * structured JSON from the model's text response rather than relying on the provider
 * to support response_format: json_schema or tool-based JSON extraction. This makes
 * it compatible with all providers including llama.cpp, LM Studio, and OpenRouter,
 * while keeping full Zod schema validation.
 */
export async function generateObjectWithRetryAsync<T extends z.ZodType>(
  options: IGenerateObjectOptions<T>,
): Promise<{ object: z.infer<T> }> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  const aiProviderService: AiProviderService = AiProviderService.getInstance();
  const providerKey: string = aiProviderService.getActiveProvider();
  const structuredMode = aiProviderService.getStructuredOutputMode();
  const providerOptions: SharedV3ProviderOptions | undefined = aiProviderService.getStructuredProviderOptions();

  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "schema_extraction";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = retryOptions.timeoutMs ?? policy.timeoutMs;

  const llmCallId = randomUUID();
  let lastError: unknown;

  // Count input tokens for status display
  const inputTokensEstimate: number = estimateTokensFromPromptAndSystem(options.prompt, options.system);

  // Set status (in-flight)
  statusService.beginInFlight("llm_request", "Waiting for structured response", {
    inputTokens: inputTokensEstimate,
    inputTokensSource: "estimate_bytes",
    callType,
    llmCallId,
    structuredMode,
  });

  try {
    for (let attempt: number = 1; attempt <= maxAttempts; attempt++) {
      try {
        const linkedSignal = createLinkedAbortSignal(retryOptions.abortSignal, timeoutMs);
        const requestProviderOptions: SharedV3ProviderOptions | undefined =
          structuredMode === "tool_auto" ? undefined : providerOptions;

        const callFn = async (): Promise<{ object: z.infer<T> }> => {
          if (structuredMode === "native_json_schema") {
            const result = await generateText({
              model: options.model,
              prompt: options.prompt,
              ...(options.system ? { system: options.system } : {}),
              output: Output.object({ schema: options.schema }),
              ...(requestProviderOptions ? { providerOptions: requestProviderOptions } : {}),
              maxRetries: 0, // Disable SDK retries - we manage retries ourselves
              abortSignal: linkedSignal,
            });

            if (result.output === undefined || result.output === null) {
              throw new Error(
                "No structured output generated: model did not return parseable JSON matching the schema." +
                (result.text ? ` Raw text: ${result.text.substring(0, 200)}` : ""),
              );
            }

            return { object: result.output };
          }

          const emitToolName = "emit_structured_output";
          const emitterTool = dynamicTool({
            description:
              "Emit final structured output. Call this tool once with JSON matching the exact schema.",
            inputSchema: options.schema,
            execute: async (input: unknown): Promise<{ object: z.infer<T> }> => {
              return { object: input as z.infer<T> };
            },
          });

          if (structuredMode === "tool_emulated") {
            const toolResult = await generateText({
              model: options.model,
              prompt: options.prompt,
              ...(options.system ? {
                system:
                  `${options.system}\n\nReturn final answer only via the tool ${emitToolName}. Do not answer in plain text.`,
              } : {
                system: `Return final answer only via the tool ${emitToolName}. Do not answer in plain text.`,
              }),
              tools: {
                [emitToolName]: emitterTool,
              },
              toolChoice: { type: "tool", toolName: emitToolName },
              ...(requestProviderOptions ? { providerOptions: requestProviderOptions } : {}),
              maxRetries: 0,
              abortSignal: linkedSignal,
            });

            const emitted = toolResult.toolResults.find((item) => item.toolName === emitToolName);
            const maybeOutput = emitted?.output as { object?: unknown } | undefined;
            if (!maybeOutput || maybeOutput.object === undefined) {
              throw new Error(
                "Tool-emulated structured output failed: no emit_structured_output tool result returned.",
              );
            }

            const parsed = options.schema.parse(maybeOutput.object) as z.infer<T>;
            return { object: parsed };
          }

          const maxToolAutoRounds: number = 3;
          let lastText: string = "";
          let shouldFallbackToTextOnly: boolean = false;

          for (let round: number = 1; round <= maxToolAutoRounds; round++) {
            const roundSuffix: string = round === 1
              ? ""
              : `\n\nPrevious attempt did not call ${emitToolName}. Retry and call only ${emitToolName} with valid JSON.`;

            try {
              const toolResult = await generateText({
                model: options.model,
                prompt: options.prompt,
                ...(options.system ? {
                  system:
                    `${options.system}\n\nReturn final answer only via the tool ${emitToolName}. Do not answer in plain text.${roundSuffix}`,
                } : {
                  system: `Return final answer only via the tool ${emitToolName}. Do not answer in plain text.${roundSuffix}`,
                }),
                tools: {
                  [emitToolName]: emitterTool,
                },
                ...(requestProviderOptions ? { providerOptions: requestProviderOptions } : {}),
                maxRetries: 0,
                abortSignal: linkedSignal,
              });

              const emitted = toolResult.toolResults.find((item) => item.toolName === emitToolName);
              const maybeOutput = emitted?.output as { object?: unknown } | undefined;

              if (maybeOutput && maybeOutput.object !== undefined) {
                const parsed = options.schema.parse(maybeOutput.object) as z.infer<T>;
                return { object: parsed };
              }

              lastText = toolResult.text ?? "";
            } catch (toolAutoError: unknown) {
              const details = extractAiErrorDetails(toolAutoError);
              const errorText: string = details.message.toLowerCase();
              const isRoutingParameterMismatch: boolean =
                details.statusCode === 404 &&
                (
                  errorText.includes("no endpoints found") ||
                  errorText.includes("requested parameters")
                );

              if (!isRoutingParameterMismatch) {
                throw toolAutoError;
              }

              shouldFallbackToTextOnly = true;
              break;
            }
          }

          const maxTextOnlyRounds: number = shouldFallbackToTextOnly ? 3 : 1;
          for (let textRound: number = 1; textRound <= maxTextOnlyRounds; textRound++) {
            if (textRound > 1 || shouldFallbackToTextOnly) {
              const textRoundSuffix: string = textRound === 1
                ? ""
                : "\n\nPrevious output was invalid. Return only a valid JSON object matching the schema.";

              const textOnlyResult = await generateText({
                model: options.model,
                prompt: options.prompt,
                ...(options.system ? {
                  system:
                    `${options.system}\n\nReturn only valid JSON object matching the requested schema. Do not call tools. Do not include markdown.${textRoundSuffix}`,
                } : {
                  system: `Return only valid JSON object matching the requested schema. Do not call tools. Do not include markdown.${textRoundSuffix}`,
                }),
                ...(requestProviderOptions ? { providerOptions: requestProviderOptions } : {}),
                maxRetries: 0,
                abortSignal: linkedSignal,
              });

              lastText = textOnlyResult.text ?? "";
            }

            const parsedFromText: unknown | null = tryParseJsonFromText(lastText);
            if (parsedFromText !== null) {
              const parsed = options.schema.parse(parsedFromText) as z.infer<T>;
              return { object: parsed };
            }
          }

          throw new Error(
            "Tool-auto structured output failed: no emit_structured_output result and no parseable JSON text after retries.",
          );
        };

        // NOTE: Do not schedule with RateLimiterService here.
        // Models from AiProviderService are already wrapped with limiter scheduling
        // in AiProviderService._wrapModelWithRateLimiter(). Scheduling again here
        // creates nested Bottleneck scheduling and can deadlock at maxConcurrent=1.
        const result: { object: z.infer<T> } = await runWithLlmCallTypeAsync(callType, callFn);

        // Record token usage for budget tracking (byte estimate for structured path).
        // Structured mode may include multiple internal sub-calls, so exact usage
        // is not consistently available from a single returned object here.
        const outputTokensEstimate: number = estimateTokensFromTextByBytes(JSON.stringify(result.object));
        rateLimiterService.recordTokenUsage(providerKey, inputTokensEstimate, outputTokensEstimate);

        logger.info("LLM structured call succeeded", {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          structuredMode,
          sdkRetriesDisabled: true,
        });

        return result;
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));

        // Check if this was an abort (cancellation or timeout)
        const isAbort = error instanceof Error && error.name === "AbortError";

        logger.warn("LLM structured call failed" + (isAbort ? " (aborted)" : ""), {
          llmCallId,
          callType,
          attempt,
          maxAttempts,
          structuredMode,
          localRetryAttempt: attempt,
          localRetryTotal: maxAttempts,
          retryLayer: "local",
          sdkRetriesDisabled: true,
          error: errorMessage,
          isAbort,
        });

        // Update status with retry info
        statusService.setStatus("llm_request", `Retrying (${attempt}/${maxAttempts})`, {
          inputTokens: inputTokensEstimate,
          inputTokensSource: "estimate_bytes",
          callType,
          llmCallId,
          structuredMode,
          error: errorMessage,
        });

        // Don't retry on abort (cancellation or timeout)
        if (isAbort) {
          break;
        }

        if (extractAiErrorDetails(error).statusCode === 429) {
          await apply429BackoffAsync({
            logger,
            error,
            retryAttempt: attempt,
            logMessage: "LLM structured call rate limited (429), waiting before retry",
            logContext: {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
            },
          });
        } else {
          const isConnectionRelatedError: boolean = isConnectionError(error);
          if (isConnectionRelatedError) {
            const retryDelayMs: number = getConnectionRetryDelayMs(attempt);
            logger.warn("LLM structured call connection error, waiting before retry", {
              llmCallId,
              callType,
              attempt,
              maxAttempts,
              structuredMode,
              retryDelayMs,
              retryType: "connection",
            });

            await new Promise<void>((resolve: () => void): void => {
              setTimeout(resolve, retryDelayMs);
            });
          }
        }
      }
    }
  } finally {
    statusService.endInFlight();
  }

  const finalErrorMsg = lastError instanceof Error
    ? lastError.message
    : String(lastError ?? "Unknown error");

  logger.error("LLM structured call failed after all retries", {
    llmCallId,
    callType,
    maxAttempts,
    structuredMode,
    localRetryTotal: maxAttempts,
    retryLayer: "local",
    sdkRetriesDisabled: true,
    error: finalErrorMsg,
  });

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM structured call failed after ${maxAttempts} retries: ${finalErrorMsg}`);
}

//#endregion Public functions
