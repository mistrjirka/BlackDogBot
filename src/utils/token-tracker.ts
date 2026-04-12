import { type ImagePart, type ModelMessage, type Tool, type ToolSet } from "ai";
import { encodingForModel } from "js-tiktoken";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { countMessagesTokens, countRequestBodyTokens } from "./request-token-counter.js";
import { estimateImageTokensFromPart } from "./image-token-estimator.js";

// Cached tokenizer to avoid recreating it on every call.
let _cachedEncoder: ReturnType<typeof encodingForModel> | null = null;

function getTextEncoder(): ReturnType<typeof encodingForModel> {
  if (!_cachedEncoder) {
    _cachedEncoder = encodingForModel("gpt-4o");
  }
  return _cachedEncoder;
}

export interface IRequestLikeTokenEstimate {
  breakdown: {
    total: number;
    messages: number;
    image: number;
    tools: number;
    system: number;
    overhead: number;
    messageCount: number;
    toolCount: number;
  };
}

export interface IRequestLikeByteTokenEstimate {
  estimatedTokens: number;
  requestSizeBytes: number;
  messageCount: number;
  toolCount: number;
}

export function countTextTokens(text: string): number {
  return getTextEncoder().encode(text).length;
}

export function estimateFixedOverhead(instructions: string, allTools: ToolSet): number {
  let overhead: number = countTextTokens(instructions);

  for (const [name, toolDef] of Object.entries(allTools)) {
    overhead += countTextTokens(name) + 10;

    if (toolDef && typeof toolDef === "object") {
      const desc: unknown = (toolDef as Record<string, unknown>).description;
      if (typeof desc === "string") {
        overhead += countTextTokens(desc);
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

        overhead += countTextTokens(schemaStr);
      }
    }
  }

  return overhead;
}

export function countTokens(messages: ModelMessage[]): number {
  const requestLikeMessages: unknown[] = messages.map(toRequestMessageForTokenCounting);
  return countMessagesTokens(requestLikeMessages);
}

export function estimateRequestLikeTokens(
  messages: ModelMessage[],
  instructions: string,
  creationPrompt: string | null,
  allTools: ToolSet,
  activeToolNames: Array<keyof ToolSet>,
): IRequestLikeTokenEstimate | null {
  try {
    const requestLikeBody: string = _buildRequestLikeBody(
      messages,
      instructions,
      creationPrompt,
      allTools,
      activeToolNames,
    );

    const breakdown = countRequestBodyTokens(requestLikeBody);
    return { breakdown };
  } catch {
    return null;
  }
}

export function estimateRequestLikeTokensByBytes(
  messages: ModelMessage[],
  instructions: string,
  creationPrompt: string | null,
  allTools: ToolSet,
  activeToolNames: Array<keyof ToolSet>,
): IRequestLikeByteTokenEstimate | null {
  try {
    const requestLikeBody: string = _buildRequestLikeBody(
      messages,
      instructions,
      creationPrompt,
      allTools,
      activeToolNames,
    );

    const requestSizeBytes: number = Buffer.byteLength(requestLikeBody, "utf8");
    const estimatedTokens: number = Math.ceil(requestSizeBytes / 4);

    return {
      estimatedTokens,
      requestSizeBytes,
      messageCount: messages.length,
      toolCount: activeToolNames.length,
    };
  } catch {
    return null;
  }
}

function toRequestMessageForTokenCounting(message: ModelMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
  };

  if (typeof message.content === "string") {
    result.content = message.content;
    return result;
  }

  if (!Array.isArray(message.content)) {
    return result;
  }

  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let imageTokenEstimateTotal: number = 0;

  for (const part of message.content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }

    if ("text" in part && typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }

    if ("type" in part && part.type === "tool-call") {
      const toolCall = part as {
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        input?: unknown;
      };

      toolCalls.push({
        id: toolCall.toolCallId ?? "",
        type: "function",
        function: {
          name: toolCall.toolName ?? "",
          arguments: JSON.stringify(toolCall.args ?? toolCall.input ?? {}),
        },
      });
      continue;
    }

    if ("type" in part && part.type === "image") {
      imageTokenEstimateTotal += _estimateImagePartTokens(part);
      continue;
    }

    if ("result" in part || "output" in part) {
      const toolResultValue: unknown = extractToolResultValue(part);
      const serialized: string = typeof toolResultValue === "string"
        ? toolResultValue
        : JSON.stringify(toolResultValue ?? null);

      textParts.push(serialized);

      const toolCallId: unknown = (part as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string" && toolCallId.length > 0) {
        result.tool_call_id = toolCallId;
      }
      continue;
    }
  }

  if (textParts.length > 0) {
    result.content = textParts.join(" ");
  }

  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls;
  }

  if (imageTokenEstimateTotal > 0) {
    result._imageTokenEstimateTotal = imageTokenEstimateTotal;
  }

  return result;
}

function extractToolResultValue(part: unknown): unknown {
  const resultPart = part as { result?: unknown; output?: unknown };

  if (resultPart.result !== undefined) {
    return resultPart.result;
  }

  if (resultPart.output !== undefined) {
    const outputObject: { type?: string; value?: unknown } = resultPart.output as { type?: string; value?: unknown };
    if (outputObject && typeof outputObject === "object" && "value" in outputObject) {
      return outputObject.value;
    }

    return resultPart.output;
  }

  return null;
}

function _estimateImagePartTokens(part: ImagePart): number {
  return estimateImageTokensFromPart(part as unknown as Record<string, unknown>);
}

function _buildRequestLikeBody(
  messages: ModelMessage[],
  instructions: string,
  creationPrompt: string | null,
  allTools: ToolSet,
  activeToolNames: Array<keyof ToolSet>,
): string {
  const requestMessages: unknown[] = messages.map(toRequestMessageForTokenCounting);

  const systemPrompt: string = creationPrompt
    ? `${instructions}\n\n${creationPrompt}`
    : instructions;

  const activeToolsPayload: unknown[] = activeToolNames
    .map((toolName: keyof ToolSet): unknown => {
      const toolDef: Tool | undefined = allTools[toolName as string];
      if (!toolDef || typeof toolDef !== "object") {
        return null;
      }

      const description: unknown = (toolDef as Record<string, unknown>).description;
      const inputSchema: unknown = (toolDef as Record<string, unknown>).inputSchema;

      let parameters: unknown = {};
      if (inputSchema instanceof z.ZodSchema) {
        parameters = zodToJsonSchema(inputSchema);
      } else if (inputSchema && typeof inputSchema === "object") {
        parameters = inputSchema;
      }

      return {
        type: "function",
        function: {
          name: String(toolName),
          description: typeof description === "string" ? description : "",
          parameters,
        },
      };
    })
    .filter((tool): tool is unknown => tool !== null);

  return JSON.stringify({
    model: "token-estimation-only",
    messages: requestMessages,
    tools: activeToolsPayload,
    system: systemPrompt,
  });
}
