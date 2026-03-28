import { AIMessage } from "@langchain/core/messages";
import {
  ChatOpenAICompletions,
  type ChatOpenAICompletionsCallOptions,
} from "@langchain/openai";
import type { BaseMessage, BaseMessageChunk } from "@langchain/core/messages";

import { ReasoningParserService } from "./reasoning/reasoning-parser.service.js";

export class ChatOpenAICompletionsReasoning<
  CallOptions extends ChatOpenAICompletionsCallOptions = ChatOpenAICompletionsCallOptions,
> extends ChatOpenAICompletions<CallOptions> {
  protected override _convertCompletionsMessageToBaseMessage(
    ...args: Parameters<ChatOpenAICompletions<CallOptions>["_convertCompletionsMessageToBaseMessage"]>
  ): BaseMessage {
    const [message, rawResponse] = args;
    const converted: BaseMessage = super._convertCompletionsMessageToBaseMessage(message, rawResponse);

    if (!AIMessage.isInstance(converted)) {
      return converted;
    }

    const messageRecord: Record<string, unknown> = message as unknown as Record<string, unknown>;
    const rawReasoningContent: unknown = messageRecord.reasoning_content;
    const rawReasoningDetails: unknown = messageRecord.reasoning_details;

    const existingAdditionalKwargs: Record<string, unknown> =
      converted.additional_kwargs ?? {};

    if (typeof rawReasoningContent === "string" && rawReasoningContent.trim().length > 0) {
      existingAdditionalKwargs.reasoning_content = rawReasoningContent;
    }

    if (rawReasoningDetails !== undefined) {
      existingAdditionalKwargs.reasoning_details = rawReasoningDetails;
    }

    const toolCallsUnknown: unknown = messageRecord.tool_calls;
    const hasToolCalls: boolean = Array.isArray(toolCallsUnknown) && toolCallsUnknown.length > 0;
    const rawContent: string = typeof message.content === "string" ? message.content : "";

    if (hasToolCalls && rawContent.trim().length > 0) {
      const parsed = ReasoningParserService.parseThinkTags(rawContent);

      const existingReasoning: string =
        typeof existingAdditionalKwargs.reasoning_content === "string"
          ? existingAdditionalKwargs.reasoning_content
          : "";

      if (existingReasoning.trim().length === 0 && parsed.reasoning && parsed.reasoning.length > 0) {
        existingAdditionalKwargs.reasoning_content = parsed.reasoning;
      }

      if (parsed.cleanedContent !== rawContent) {
        converted.content = parsed.cleanedContent;
      }
    }

    converted.additional_kwargs = existingAdditionalKwargs;

    return converted;
  }

  protected override _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<ChatOpenAICompletions<CallOptions>["_convertCompletionsDeltaToBaseMessageChunk"]>
  ): BaseMessageChunk {
    const [delta, rawResponse, defaultRole] = args;
    const chunk: BaseMessageChunk = super._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      rawResponse,
      defaultRole,
    );

    const chunkRecord: Record<string, unknown> = chunk as unknown as Record<string, unknown>;
    const additionalKwargsUnknown: unknown = chunkRecord.additional_kwargs;

    if (typeof additionalKwargsUnknown === "object" && additionalKwargsUnknown !== null) {
      const additionalKwargs: Record<string, unknown> = additionalKwargsUnknown as Record<string, unknown>;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.trim().length > 0) {
        additionalKwargs.reasoning_content = delta.reasoning_content;
      }
      if (delta.reasoning_details !== undefined) {
        additionalKwargs.reasoning_details = delta.reasoning_details;
      }
      chunkRecord.additional_kwargs = additionalKwargs;
    }

    return chunk;
  }
}
