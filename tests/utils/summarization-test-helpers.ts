import { vi } from "vitest";
import type { ModelMessage } from "ai";

import { LoggerService } from "../../src/services/logger.service.js";

/**
 * Approximate token count using JSON string length.
 * Used in unit tests where exact tiktoken counting is not needed.
 */
export function countApprox(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length;
}

/**
 * Create a mock tool message for testing.
 */
export function makeToolMessage(toolCallId: string, text: string): ModelMessage {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId,
      output: { type: "text", value: text },
    }],
  } as ModelMessage;
}

/**
 * Create a mock logger service for testing.
 */
export function makeLogger(): LoggerService {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as LoggerService;
}
