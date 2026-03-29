import type { AIMessage, BaseMessage } from "@langchain/core/messages";

import { ReasoningParserService } from "../services/providers/reasoning/reasoning-parser.service.js";
import { ReasoningNormalizerService } from "../services/providers/reasoning/reasoning-normalizer.service.js";
import type { IResolvedToolCall } from "../services/providers/reasoning/reasoning.types.js";

//#region Public Functions

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];

  for (const contentPart of content) {
    if (typeof contentPart === "string") {
      textParts.push(contentPart);
      continue;
    }

    if (typeof contentPart !== "object" || contentPart === null) {
      continue;
    }

    const contentRecord: Record<string, unknown> = contentPart as Record<string, unknown>;
    if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
      textParts.push(contentRecord.text);
    }
  }

  return textParts.join("\n");
}

export function extractNormalizedCronResponseText(messages: BaseMessage[]): string {
  let responseText: string = "";

  for (let i: number = messages.length - 1; i >= 0; i--) {
    const message: BaseMessage = messages[i];
    if (message._getType() !== "ai") {
      continue;
    }

    const aiMessage: AIMessage = message as AIMessage;
    const content: unknown = aiMessage.content;
    let contentText: string = "";

    if (typeof content === "string") {
      contentText = content;
    } else if (Array.isArray(content)) {
      const textBlocks = content.filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text",
      );
      contentText = textBlocks.map((block: { type: "text"; text: string }): string => block.text).join("");
    }

    const additionalKwargs: Record<string, unknown> =
      (aiMessage.additional_kwargs ?? {}) as Record<string, unknown>;
    const reasoningContent: string = ReasoningParserService.extractReasoningFromAdditionalKwargs(additionalKwargs);
    const normalized = ReasoningNormalizerService.normalize({
      content: contentText,
      reasoningContent,
    });

    responseText = normalized.text;
    if (responseText.length > 0) {
      break;
    }
  }

  return responseText;
}

export function resolveToolCallsFromAiMessage(message: AIMessage): IResolvedToolCall[] {
  const aiContent: string = extractTextContent(message.content);
  const additionalKwargs: Record<string, unknown> =
    (message.additional_kwargs ?? {}) as Record<string, unknown>;

  return ReasoningNormalizerService.resolveToolCalls(
    message.tool_calls,
    aiContent,
    additionalKwargs,
  );
}

export function buildToolResultPreview(toolResultMessage: BaseMessage | undefined): string {
  if (!toolResultMessage) {
    return "";
  }

  const toolContent: unknown = (toolResultMessage as unknown as { content?: unknown }).content;
  if (typeof toolContent === "string") {
    return toolContent.slice(0, 500);
  }

  if (Array.isArray(toolContent)) {
    return toolContent
      .map((contentPart: unknown): string =>
        typeof contentPart === "string" ? contentPart : JSON.stringify(contentPart),
      )
      .join("")
      .slice(0, 500);
  }

  return JSON.stringify(toolContent).slice(0, 500);
}

//#endregion Public Functions
