import { LoggerService } from "../services/logger.service.js";
import { encodingForModel } from "js-tiktoken";

//#region Types

export interface IRequestTokenBreakdown {
  total: number;
  messages: number;
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

    const messagesTokens = countMessagesTokens(messages);
    const toolsTokens = tools.length > 0 ? _countTextTokens(JSON.stringify(tools)) : 0;
    const systemTokens = system ? _countTextTokens(system) : 0;

    const total = _countTextTokens(requestBody);
    const overhead = total - messagesTokens - toolsTokens - systemTokens;

    return {
      total,
      messages: messagesTokens,
      tools: toolsTokens,
      system: systemTokens,
      overhead,
      messageCount: messages.length,
      toolCount: tools.length,
    };
  } catch (error: unknown) {
    logger.warn("Failed to parse request body for token counting", { error: String(error) });

    return {
      total: 0,
      messages: 0,
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
      total += _countTextTokens(JSON.stringify(m.content));
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
  }

  return total;
}

//#endregion Private Functions
