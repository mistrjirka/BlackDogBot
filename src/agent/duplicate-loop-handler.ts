import { z } from "zod";
import type { ModelMessage } from "ai";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import {
  EDuplicateLoopAction,
  type IDuplicateToolCallLoopInfo,
} from "./base-agent.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";

const DuplicateLoopAdviserSchema = z.object({
  reasoning: z.string().describe("Analysis of why the duplicate loop is occurring and what the model should do differently"),
  recommendation: z.string().describe("Concrete recommendation for the model to break the loop and complete the user task"),
});

export class DuplicateLoopHandler {
  static readonly MAX_ATTEMPTS: number = 3;

  private _logger = LoggerService.getInstance();

  handle(
    chatId: string,
    loopInfo: IDuplicateToolCallLoopInfo,
    stepNumber: number,
    messages: ModelMessage[],
    escalationState: { activeSignature: string | null; adviserAttemptsRemaining: number },
    steeringQueue: string[],
    loggerContext: { info: (msg: string, ctx?: Record<string, unknown>) => void; warn: (msg: string, ctx?: Record<string, unknown>) => void },
  ): { action: EDuplicateLoopAction; newEscalationState: typeof escalationState } {
    const signature: string = loopInfo.canonicalSignature;
    const summary: string = loopInfo.summaryString;

    if (escalationState.activeSignature === null) {
      escalationState.activeSignature = signature;
      escalationState.adviserAttemptsRemaining = DuplicateLoopHandler.MAX_ATTEMPTS;
      loggerContext.info("Duplicate loop: first detection, forcing think", {
        chatId,
        stepNumber,
        signature,
        summary,
      });
      return { action: EDuplicateLoopAction.ForceThink, newEscalationState: escalationState };
    }

    if (escalationState.activeSignature !== signature) {
      const previousSignature: string = escalationState.activeSignature;
      escalationState.activeSignature = signature;
      escalationState.adviserAttemptsRemaining = DuplicateLoopHandler.MAX_ATTEMPTS;
      loggerContext.info("Duplicate loop: new signature detected, forcing think", {
        chatId,
        stepNumber,
        previousSignature,
        newSignature: signature,
        summary,
      });
      return { action: EDuplicateLoopAction.ForceThink, newEscalationState: escalationState };
    }

    if (escalationState.adviserAttemptsRemaining <= 0) {
      loggerContext.warn("Duplicate loop: adviser attempts exhausted, hard stop", {
        chatId,
        stepNumber,
        signature,
        summary,
      });
      return { action: EDuplicateLoopAction.HardStop, newEscalationState: escalationState };
    }

    escalationState.adviserAttemptsRemaining--;

    const historySlice: ModelMessage[] = this._buildHistorySliceForAdviser(messages);

    loggerContext.info("Duplicate loop: calling adviser model", {
      chatId,
      stepNumber,
      signature,
      summary,
      adviserAttemptsRemaining: escalationState.adviserAttemptsRemaining,
      historySliceLength: historySlice.length,
    });

    this._callAdviserAsync(
      chatId,
      stepNumber,
      signature,
      summary,
      _findFirstUserTask(messages),
      historySlice,
      escalationState.adviserAttemptsRemaining,
      steeringQueue,
    ).catch(() => {
      // Already logged in _callAdviserAsync
    });

    return { action: EDuplicateLoopAction.ForceThink, newEscalationState: escalationState };
  }

  private _buildHistorySliceForAdviser(messages: ModelMessage[]): ModelMessage[] {
    let startIndex: number = -1;
    for (let i: number = 0; i < messages.length; i++) {
      if (messages[i].role === "user") {
        startIndex = i;
        break;
      }
    }

    if (startIndex < 0) {
      return [];
    }

    let endIndex: number = -1;
    for (let i: number = messages.length - 1; i >= startIndex; i--) {
      const message: ModelMessage = messages[i];
      if (message.role !== "assistant") {
        continue;
      }

      if (!Array.isArray(message.content)) {
        continue;
      }

      const hasToolCall: boolean = message.content.some((part): boolean => {
        return (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "tool-call"
        );
      });

      if (hasToolCall) {
        endIndex = i;
        break;
      }
    }

    if (endIndex < 0) {
      return messages.slice(startIndex);
    }

    let sliceEnd: number = endIndex;
    for (let i: number = endIndex + 1; i < messages.length; i++) {
      const message: ModelMessage = messages[i];
      if (message.role === "assistant") {
        break;
      }
      if (message.role === "tool") {
        sliceEnd = i;
      }
    }

    return messages.slice(startIndex, sliceEnd + 1);
  }

  private async _callAdviserAsync(
    chatId: string,
    stepNumber: number,
    signature: string,
    summary: string,
    userTask: string,
    historySlice: ModelMessage[],
    adviserAttemptsRemaining: number,
    steeringQueue: string[],
  ): Promise<void> {
    const logger = this._logger;

    try {
      const adviserResult = await generateObjectWithRetryAsync({
        model: AiProviderService.getInstance().getModel(),
        prompt: createDuplicateLoopAdviserPrompt(userTask, historySlice, summary, historySlice.length),
        schema: DuplicateLoopAdviserSchema,
        system: "You are an expert AI assistant helping a model break out of a duplicate tool call loop.",
        retryOptions: {
          maxAttempts: 2,
          timeoutMs: 60000,
          callType: "agent_primary",
        },
      });

      logger.info("Duplicate loop adviser recommendation", {
        chatId,
        stepNumber,
        signature,
        adviserAttemptsRemaining,
        reasoning: adviserResult.object.reasoning,
        recommendation: adviserResult.object.recommendation,
      });

      steeringQueue.push(
        `Duplicate-loop adviser recommendation: ${adviserResult.object.recommendation}`,
      );
    } catch (adviserError: unknown) {
      logger.warn("Duplicate loop adviser call failed, forcing think", {
        chatId,
        stepNumber,
        signature,
        error: adviserError instanceof Error ? adviserError.message : String(adviserError),
      });
    }
  }

  reset(escalationState: { activeSignature: string | null; adviserAttemptsRemaining: number }): void {
    escalationState.activeSignature = null;
    escalationState.adviserAttemptsRemaining = DuplicateLoopHandler.MAX_ATTEMPTS;
  }
}

export function createDuplicateLoopAdviserPrompt(
  userTask: string,
  historySlice: ModelMessage[],
  loopSignature: string,
  duplicateCount: number,
): string {
  const historyJson: string = JSON.stringify(historySlice, null, 2);

  return `You are an expert AI assistant helping a model break out of a duplicate tool call loop.

## User's Original Task
${userTask}

## The Problem
The model is stuck calling the same tool(s) with identical arguments ${duplicateCount} times in a row:
${loopSignature}

## Recent Conversation History (user task to last tool call, with tool results)
\`\`\`json
${historyJson}
\`\`\`

## Your Analysis
Analyze the conversation history and explain:
1. Why the model might be stuck in this loop
2. What the model should do differently to complete the user's task
3. A concrete recommendation for the next action to take

Provide your reasoning and recommendation in the specified format.`;
}

function _findFirstUserTask(messages: ModelMessage[]): string {
  for (let i: number = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") {
        return content.slice(0, 256);
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            (part as { type: string }).type === "text" &&
            "text" in part &&
            typeof (part as { text: unknown }) === "string"
          ) {
            return (part as { text: string }).text.slice(0, 256);
          }
        }
      }
    }
  }
  return "";
}
