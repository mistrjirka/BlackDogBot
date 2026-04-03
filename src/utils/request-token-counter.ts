import { LoggerService } from "../services/logger.service.js";
import { encodingForModel } from "js-tiktoken";
import { estimateImageTokensFromPart, isImageContentPart } from "./image-token-estimator.js";

//#region Types

export interface IRequestTokenBreakdown {
  total: number;
  messages: number;
  image: number;
  tools: number;
  system: number;
  overhead: number;
  messageCount: number;
  toolCount: number;
}

//#endregion Types

//#region Data members

let _encoder: ReturnType<typeof encodingForModel> | null = null;

//#endregion Data members

//#region Public Functions

export function countRequestBodyTokens(requestBody: string): IRequestTokenBreakdown {
  const logger: LoggerService = LoggerService.getInstance();

  try {
    const body = JSON.parse(requestBody);

    const messages = body.messages ?? [];
    const tools = body.tools ?? [];
    const system = body.system ?? "";
    const sanitizedBody: string = _buildSanitizedRequestBodyForCounting(body);

    const imageTokens = _sumImageTokenEstimates(messages);
    const messagesTokens = countMessagesTokens(messages);
    const toolsTokens = tools.length > 0 ? _countTextTokens(JSON.stringify(tools)) : 0;
    const systemTokens = system ? _countTextTokens(system) : 0;

    const total = _countTextTokens(sanitizedBody) + imageTokens;
    const overhead = total - messagesTokens - imageTokens - toolsTokens - systemTokens;

    return {
      total,
      messages: messagesTokens,
      image: imageTokens,
      tools: toolsTokens,
      system: systemTokens,
      overhead,
      messageCount: messages.length,
      toolCount: tools.length,
    };
  } catch (error: unknown) {
    logger.error("Failed to parse request body for token counting — returning null to signal failure", {
      error: String(error),
    });

    // Return null-like breakdown so caller knows counting failed
    return {
      total: -1,
      messages: 0,
      image: 0,
      tools: 0,
      system: 0,
      overhead: 0,
      messageCount: 0,
      toolCount: 0,
    };
  }
}

//#endregion Public Functions

//#region Private Functions

function _getEncoder(): ReturnType<typeof encodingForModel> {
  if (!_encoder) {
    _encoder = encodingForModel("gpt-4o");
  }

  return _encoder;
}

function _countTextTokens(text: string): number {
  return _getEncoder().encode(text).length;
}

export function countMessagesTokens(messages: unknown[]): number {
  let total = 0;

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      continue;
    }

    const m = msg as Record<string, unknown>;

    total += 15;

    if (typeof m.content === "string") {
      total += _countTextTokens(m.content);
    } else if (Array.isArray(m.content)) {
      total += _countMessageArrayContentTokens(m.content);
    }

    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      total += _countTextTokens(JSON.stringify(m.tool_calls));
    }

    if (m.tool_call_id && typeof m.tool_call_id === "string") {
      total += _countTextTokens(m.tool_call_id);
    }

    if (m.name && typeof m.name === "string") {
      total += _countTextTokens(m.name);
    }

    if (typeof m._imageTokenEstimateTotal === "number" && Number.isFinite(m._imageTokenEstimateTotal)) {
      const imageTokens: number = Math.max(0, Math.ceil(m._imageTokenEstimateTotal));
      total += imageTokens;
    }
  }

  return total;
}

function _sumImageTokenEstimates(messages: unknown[]): number {
  let total: number = 0;

  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      continue;
    }

    const candidate: Record<string, unknown> = message as Record<string, unknown>;
    const imageEstimate: unknown = candidate._imageTokenEstimateTotal;
    if (typeof imageEstimate === "number" && Number.isFinite(imageEstimate)) {
      total += Math.max(0, Math.ceil(imageEstimate));
      continue;
    }

    const content: unknown = candidate.content;
    if (!Array.isArray(content)) {
      continue;
    }

    total += _sumImageTokenEstimatesFromContentParts(content);
  }

  return total;
}

function _sumImageTokenEstimatesFromContentParts(contentParts: unknown[]): number {
  let total: number = 0;

  for (const part of contentParts) {
    if (!isImageContentPart(part)) {
      continue;
    }

    if (typeof part !== "object" || part === null) {
      total += estimateImageTokensFromPart({});
      continue;
    }

    total += estimateImageTokensFromPart(part as Record<string, unknown>);
  }

  return total;
}

function _countMessageArrayContentTokens(contentParts: unknown[]): number {
  let total: number = 0;

  for (const part of contentParts) {
    if (typeof part === "string") {
      total += _countTextTokens(part);
      continue;
    }

    if (typeof part !== "object" || part === null) {
      continue;
    }

    const candidate: Record<string, unknown> = part as Record<string, unknown>;

    if (isImageContentPart(candidate)) {
      continue;
    }

    if (typeof candidate.text === "string") {
      total += _countTextTokens(candidate.text);
      continue;
    }

    if (candidate.type === "tool-call") {
      const toolCallId: string = typeof candidate.toolCallId === "string" ? candidate.toolCallId : "";
      const toolName: string = typeof candidate.toolName === "string" ? candidate.toolName : "";
      const args: unknown = "args" in candidate ? candidate.args : ("input" in candidate ? candidate.input : null);
      total += _countTextTokens(JSON.stringify({ toolCallId, toolName, args }));
      continue;
    }

    if (candidate.type === "tool-result") {
      const result: unknown = "result" in candidate
        ? candidate.result
        : ("output" in candidate ? candidate.output : null);
      total += _countTextTokens(typeof result === "string" ? result : JSON.stringify(result ?? null));
      continue;
    }

    total += _countTextTokens(JSON.stringify(candidate));
  }

  return total;
}

function _buildSanitizedRequestBodyForCounting(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return JSON.stringify(body);
  }

  const clone: Record<string, unknown> = {
    ...(body as Record<string, unknown>),
  };

  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map((message: unknown): unknown => _sanitizeMessageForTokenCounting(message));
  }

  return JSON.stringify(clone);
}

function _sanitizeMessageForTokenCounting(message: unknown): unknown {
  if (typeof message !== "object" || message === null) {
    return message;
  }

  const clone: Record<string, unknown> = {
    ...(message as Record<string, unknown>),
  };

  if (!Array.isArray(clone.content)) {
    return clone;
  }

  clone.content = clone.content.map((part: unknown): unknown => {
    if (!isImageContentPart(part)) {
      return part;
    }

    const estimate: number = (typeof part === "object" && part !== null)
      ? estimateImageTokensFromPart(part as Record<string, unknown>)
      : estimateImageTokensFromPart({});

    return {
      type: "image_token_estimate",
      tokens: estimate,
    };
  });

  return clone;
}

//#endregion Private Functions
