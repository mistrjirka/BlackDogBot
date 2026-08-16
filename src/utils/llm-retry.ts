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

function getEffectiveTimeout(requestedTimeoutMs: number | undefined, policyTimeoutMs: number): number {
  const floor: number = AiProviderService.getInstance().getGenerationTimeoutFloorMs();
  const effectiveRequested: number = requestedTimeoutMs ?? policyTimeoutMs;
  return Math.max(effectiveRequested, floor);
}

function createLinkedAbortSignal(
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!abortSignal && timeoutMs === Infinity) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();

  const abortFn = (): void => {
    controller.abort();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
      return { signal: controller.signal, cleanup: () => {} };
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

  // Cleanup function for callers to invoke after the call completes
  const cleanup = (): void => {
    clearTimeout(timeoutId);
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortFn);
    }
  };

  return { signal: controller.signal, cleanup };
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

//#region Private Retry Engine

interface IRetryContext {
  llmCallId: string;
  callType: LlmCallType;
  maxAttempts: number;
  timeoutMs: number;
  inputTokensEstimate: number;
  abortSignal: AbortSignal | undefined;
  providerKey: string;
  structuredMode?: string;
}

interface ILlmCallResult<T> {
  result: T;
  inputTokens: number;
  outputTokens: number;
}

async function executeLlmCallWithRetryAsync<T>(
  ctx: IRetryContext,
  callFn: (linkedSignal: AbortSignal | undefined) => Promise<ILlmCallResult<T>>,
): Promise<T> {
  const logger: LoggerService = LoggerService.getInstance();
  const rateLimiterService: RateLimiterService = RateLimiterService.getInstance();
  const statusService: StatusService = StatusService.getInstance();
  let lastError: unknown;
  const isStructured: boolean = ctx.structuredMode !== undefined;
  const successMessage: string = isStructured ? "LLM structured call succeeded" : "LLM call succeeded";
  const failureMessage: string = isStructured ? "LLM structured call failed" : "LLM call failed";
  const connectionMessage: string = isStructured
    ? "LLM structured call connection error, waiting before retry"
    : "LLM call connection error, waiting before retry";
  const rateLimitMessage: string = isStructured
    ? "LLM structured call rate limited (429), waiting before retry"
    : "LLM call rate limited (429), waiting before retry";
  const statusLabel: string = isStructured ? "Waiting for structured response" : "Waiting for response";

  const initialStatus: Record<string, unknown> = {
    inputTokens: ctx.inputTokensEstimate,
    inputTokensSource: "estimate_bytes",
    callType: ctx.callType,
    llmCallId: ctx.llmCallId,
    ...(isStructured ? { structuredMode: ctx.structuredMode } : {}),
  };
  statusService.beginInFlight("llm_request", statusLabel, initialStatus);

  try {
    for (let attempt: number = 1; attempt <= ctx.maxAttempts; attempt++) {
      try {
        const { signal: linkedSignal, cleanup: cleanupSignal } = createLinkedAbortSignal(ctx.abortSignal, ctx.timeoutMs);

        // NOTE: Do not schedule with RateLimiterService here.
        // Models from AiProviderService are already wrapped with limiter scheduling
        // in AiProviderService._wrapModelWithRateLimiter(). Scheduling again here
        // creates nested Bottleneck scheduling and can deadlock at maxConcurrent=1.
        let result: ILlmCallResult<T>;
        try {
          result = await runWithLlmCallTypeAsync(ctx.callType, () => callFn(linkedSignal));
        } finally {
          cleanupSignal();
        }

        rateLimiterService.recordTokenUsage(ctx.providerKey, result.inputTokens, result.outputTokens);
        logger.info(successMessage, {
          llmCallId: ctx.llmCallId,
          callType: ctx.callType,
          attempt,
          maxAttempts: ctx.maxAttempts,
          ...(isStructured ? { structuredMode: ctx.structuredMode } : {
            inputTokensEstimate: ctx.inputTokensEstimate,
            inputTokensActual: result.inputTokens,
            outputTokensActual: result.outputTokens,
          }),
          sdkRetriesDisabled: true,
        });
        return result.result;
      } catch (error: unknown) {
        lastError = error;
        const errorMessage: string = formatAiErrorForLog(extractAiErrorDetails(error));
        const isAbort = error instanceof Error && error.name === "AbortError";
        logger.warn(failureMessage + (isAbort ? " (aborted)" : ""), {
          llmCallId: ctx.llmCallId,
          callType: ctx.callType,
          attempt,
          maxAttempts: ctx.maxAttempts,
          ...(isStructured ? { structuredMode: ctx.structuredMode } : {}),
          localRetryAttempt: attempt,
          localRetryTotal: ctx.maxAttempts,
          retryLayer: "local",
          sdkRetriesDisabled: true,
          error: errorMessage,
          isAbort,
        });
        statusService.setStatus("llm_request", `Retrying (${attempt}/${ctx.maxAttempts})`, {
          inputTokens: ctx.inputTokensEstimate,
          inputTokensSource: "estimate_bytes",
          callType: ctx.callType,
          llmCallId: ctx.llmCallId,
          ...(isStructured ? { structuredMode: ctx.structuredMode } : {}),
          error: errorMessage,
        });
        if (isAbort) break;
        if (extractAiErrorDetails(error).statusCode === 429) {
          await apply429BackoffAsync({
            logger,
            error,
            retryAttempt: attempt,
            logMessage: rateLimitMessage,
            logContext: { llmCallId: ctx.llmCallId, callType: ctx.callType, attempt, maxAttempts: ctx.maxAttempts },
          });
        } else if (isConnectionError(error)) {
          const retryDelayMs: number = getConnectionRetryDelayMs(attempt);
          logger.warn(connectionMessage, {
            llmCallId: ctx.llmCallId,
            callType: ctx.callType,
            attempt,
            maxAttempts: ctx.maxAttempts,
            ...(isStructured ? { structuredMode: ctx.structuredMode } : {}),
            retryDelayMs,
            retryType: "connection",
          });
          await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, retryDelayMs); });
        }
      }
    }
  } finally {
    statusService.endInFlight();
  }

  const finalErrorMsg = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown error");
  logger.error(isStructured ? "LLM structured call failed after all retries" : "LLM call failed after all retries", {
    llmCallId: ctx.llmCallId,
    callType: ctx.callType,
    maxAttempts: ctx.maxAttempts,
    ...(isStructured ? { structuredMode: ctx.structuredMode } : {}),
    localRetryTotal: ctx.maxAttempts,
    retryLayer: "local",
    sdkRetriesDisabled: true,
    error: finalErrorMsg,
  });
  throw lastError instanceof Error ? lastError : new Error(`LLM ${isStructured ? "structured " : ""}call failed after ${ctx.maxAttempts} retries: ${finalErrorMsg}`);
}

//#endregion Private Retry Engine

//#region Public functions

export async function generateTextWithRetryAsync(options: IGenerateTextOptions): Promise<{ text: string }> {
  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "agent_primary";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = getEffectiveTimeout(retryOptions.timeoutMs, policy.timeoutMs);
  const inputTokensEstimate: number = estimateTokensFromPromptAndSystem(options.prompt, options.system);
  const providerKey: string = AiProviderService.getInstance().getActiveProvider();
  const result = await executeLlmCallWithRetryAsync<{ text: string }>({
    llmCallId: randomUUID(), callType, maxAttempts, timeoutMs, inputTokensEstimate,
    abortSignal: retryOptions.abortSignal, providerKey,
  }, async (linkedSignal: AbortSignal | undefined): Promise<ILlmCallResult<{ text: string }>> => {
    const result = await generateText({ model: options.model, prompt: options.prompt, ...(options.system ? { system: options.system } : {}), maxRetries: 0, abortSignal: linkedSignal });
    const inputTokens: number = result.totalUsage?.inputTokens ?? result.usage?.inputTokens ?? inputTokensEstimate;
    const outputTokens: number = result.totalUsage?.outputTokens ?? result.usage?.outputTokens ?? estimateTokensFromTextByBytes(result.text ?? "");
    return { result: { text: result.text ?? "" }, inputTokens, outputTokens };
  });
  return result;
}

/**
 * Generates structured output using generateText + Output.object() with retry logic
 * and rate limiting. Guarantees valid JSON matching the provided Zod schema.
 */
export async function generateObjectWithRetryAsync<T extends z.ZodType>(options: IGenerateObjectOptions<T>): Promise<{ object: z.infer<T> }> {
  const aiProviderService: AiProviderService = AiProviderService.getInstance();
  const providerKey: string = aiProviderService.getActiveProvider();
  const structuredMode = aiProviderService.getStructuredOutputMode();
  const providerOptions: SharedV3ProviderOptions | undefined = aiProviderService.getStructuredProviderOptions();
  const retryOptions = options.retryOptions ?? {};
  const callType = retryOptions.callType ?? "schema_extraction";
  const policy = getRetryPolicy(callType);
  const maxAttempts = retryOptions.maxAttempts ?? policy.maxAttempts;
  const timeoutMs = getEffectiveTimeout(retryOptions.timeoutMs, policy.timeoutMs);
  const inputTokensEstimate: number = estimateTokensFromPromptAndSystem(options.prompt, options.system);
  const result = await executeLlmCallWithRetryAsync<{ object: z.infer<T> }>({
    llmCallId: randomUUID(), callType, maxAttempts, timeoutMs, inputTokensEstimate,
    abortSignal: retryOptions.abortSignal, providerKey, structuredMode,
  }, async (linkedSignal: AbortSignal | undefined): Promise<ILlmCallResult<{ object: z.infer<T> }>> => {
    const requestProviderOptions: SharedV3ProviderOptions | undefined = structuredMode === "tool_auto" ? undefined : providerOptions;
    const emitToolName = "emit_structured_output";
    const emitterTool = dynamicTool({ description: "Emit final structured output. Call this tool once with JSON matching the exact schema.", inputSchema: options.schema, execute: async (input: unknown): Promise<{ object: z.infer<T> }> => ({ object: input as z.infer<T> }) });
    let object: z.infer<T>;
    if (structuredMode === "native_json_schema") {
      const generated = await generateText({ model: options.model, prompt: options.prompt, ...(options.system ? { system: options.system } : {}), output: Output.object({ schema: options.schema }), ...(requestProviderOptions ? { providerOptions: requestProviderOptions } : {}), maxRetries: 0, abortSignal: linkedSignal });
      if (generated.output === undefined || generated.output === null) throw new Error("No structured output generated: model did not return parseable JSON matching the schema." + (generated.text ? ` Raw text: ${generated.text.substring(0, 200)}` : ""));
      object = generated.output;
    } else if (structuredMode === "tool_emulated") {
      const generated = await generateText({ model: options.model, prompt: options.prompt, ...(options.system ? { system: `${options.system}\n\nReturn final answer only via the tool ${emitToolName}. Do not answer in plain text.` } : { system: `Return final answer only via the tool ${emitToolName}. Do not answer in plain text.` }), tools: { [emitToolName]: emitterTool }, toolChoice: { type: "tool", toolName: emitToolName }, ...(requestProviderOptions ? { providerOptions: requestProviderOptions } : {}), maxRetries: 0, abortSignal: linkedSignal });
      const emitted = generated.toolResults.find((item) => item.toolName === emitToolName);
      const maybeOutput = emitted?.output as { object?: unknown } | undefined;
      if (!maybeOutput || maybeOutput.object === undefined) throw new Error("Tool-emulated structured output failed: no emit_structured_output tool result returned.");
      object = options.schema.parse(maybeOutput.object) as z.infer<T>;
    } else {
      let parsed: z.infer<T> | undefined;
      for (let round: number = 1; round <= 3; round++) {
        const roundSuffix: string = round === 1 ? "" : `\n\nPrevious attempt did not call ${emitToolName}. Retry and call only ${emitToolName} with valid JSON.`;
        try {
          const generated = await generateText({ model: options.model, prompt: options.prompt, ...(options.system ? { system: `${options.system}\n\nReturn final answer only via the tool ${emitToolName}. Do not answer in plain text.${roundSuffix}` } : { system: `Return final answer only via the tool ${emitToolName}. Do not answer in plain text.${roundSuffix}` }), tools: { [emitToolName]: emitterTool }, ...(requestProviderOptions ? { providerOptions: requestProviderOptions } : {}), maxRetries: 0, abortSignal: linkedSignal });
          const emitted = generated.toolResults.find((item) => item.toolName === emitToolName);
          const maybeOutput = emitted?.output as { object?: unknown } | undefined;
          if (maybeOutput && maybeOutput.object !== undefined) { parsed = options.schema.parse(maybeOutput.object) as z.infer<T>; break; }
        } catch (toolAutoError: unknown) {
          const details = extractAiErrorDetails(toolAutoError); const errorText: string = details.message.toLowerCase();
          if (!(details.statusCode === 404 && (errorText.includes("no endpoints found") || errorText.includes("requested parameters")))) throw toolAutoError;
        }
      }
      if (parsed === undefined) throw new Error("Tool-auto structured output failed: no emit_structured_output result after retries.");
      object = parsed;
    }
    return { result: { object }, inputTokens: inputTokensEstimate, outputTokens: estimateTokensFromTextByBytes(JSON.stringify(object)) };
  });
  return result;
}

//#endregion Public functions
