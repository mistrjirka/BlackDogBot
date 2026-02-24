import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import { LoggerService } from "../services/logger.service.js";

/**
 * Attempts to repair malformed tool call JSON from the model.
 *
 * Common issues (especially on OpenRouter):
 * - Raw newlines/tabs inside JSON string values
 * - Trailing commas
 */
export async function repairToolCallJsonAsync({
  toolCall,
}: {
  toolCall: LanguageModelV3ToolCall;
  error: unknown;
}): Promise<LanguageModelV3ToolCall | null> {
  const logger: LoggerService = LoggerService.getInstance();
  const raw: string = toolCall.input;

  // Replace unescaped control characters inside string values with their escape sequences
  let repaired: string = raw.replace(/[\x00-\x1f]/g, (ch: string) => {
    switch (ch) {
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      default: return "";
    }
  });

  // Remove trailing commas before closing braces/brackets
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  try {
    // Validate that the repaired string is valid JSON
    JSON.parse(repaired);
  } catch {
    logger.warn("Tool call repair failed — JSON still invalid after sanitization", {
      toolName: toolCall.toolName,
      originalInput: raw,
    });

    return null;
  }

  logger.debug("Repaired malformed tool call JSON", { 
    toolName: toolCall.toolName,
    originalInput: raw,
    repairedInput: repaired 
  });

  return { ...toolCall, input: repaired };
}
