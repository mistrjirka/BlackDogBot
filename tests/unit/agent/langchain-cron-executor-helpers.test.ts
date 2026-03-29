import { describe, expect, it, vi, beforeEach } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import {
  extractTextContent,
  extractNormalizedCronResponseText,
  resolveToolCallsFromAiMessage,
  buildToolResultPreview,
} from "../../../src/agent/langchain-cron-executor-helpers.js";
import { ReasoningParserService } from "../../../src/services/providers/reasoning/reasoning-parser.service.js";
import { ReasoningNormalizerService } from "../../../src/services/providers/reasoning/reasoning-normalizer.service.js";

vi.mock("../../../src/services/providers/reasoning/reasoning-parser.service.js");
vi.mock("../../../src/services/providers/reasoning/reasoning-normalizer.service.js");

describe("langchain-cron-executor-helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("extractTextContent", () => {
    it("returns string input unchanged", () => {
      const result: string = extractTextContent("Hello world");
      expect(result).toBe("Hello world");
    });

    it("extracts text from content array with text blocks", () => {
      const content: unknown = [
        { type: "text", text: "First part" },
        { type: "text", text: "Second part" },
      ];
      const result: string = extractTextContent(content);
      expect(result).toBe("First part\nSecond part");
    });

    it("handles mixed content array entries", () => {
      const content: unknown = [
        { type: "text", text: "Text block" },
        { type: "image", data: "base64data" },
        "plain string",
        { type: "other" },
      ];
      const result: string = extractTextContent(content);
      expect(result).toBe("Text block\nplain string");
    });

    it("returns empty string for non-array non-string input", () => {
      const result: string = extractTextContent(123);
      expect(result).toBe("");
    });

    it("returns empty string for null", () => {
      const result: string = extractTextContent(null);
      expect(result).toBe("");
    });
  });

  describe("buildToolResultPreview", () => {
    it("returns empty string for undefined input", () => {
      const result: string = buildToolResultPreview(undefined);
      expect(result).toBe("");
    });

    it("returns string content truncated to 500 chars", () => {
      const longText: string = "a".repeat(600);
      const message = { content: longText } as unknown as { _getType: () => string; content: unknown };
      const result: string = buildToolResultPreview(message as never);
      expect(result.length).toBe(500);
    });

    it("returns array content joined and truncated", () => {
      const message = {
        content: ["part1", "part2"],
      } as unknown as { _getType: () => string; content: unknown };
      const result: string = buildToolResultPreview(message as never);
      expect(result).toBe("part1part2");
    });

    it("returns stringified object content", () => {
      const message = {
        content: { key: "value", num: 42 },
      } as unknown as { _getType: () => string; content: unknown };
      const result: string = buildToolResultPreview(message as never);
      expect(result).toBe('{"key":"value","num":42}');
    });
  });

  describe("extractNormalizedCronResponseText", () => {
    it("extracts and normalizes text content from AIMessage", () => {
      const mockExtractReasoning = ReasoningParserService.extractReasoningFromAdditionalKwargs as ReturnType<typeof vi.fn>;
      mockExtractReasoning.mockReturnValue("");

      const mockNormalize = ReasoningNormalizerService.normalize as ReturnType<typeof vi.fn>;
      mockNormalize.mockReturnValue({ text: "Normalized response", reasoning: "" });

      const aiMessage: AIMessage = new AIMessage({
        content: "Raw response text",
        tool_calls: [],
      });

      const result: string = extractNormalizedCronResponseText([aiMessage]);
      expect(result).toBe("Normalized response");
      expect(mockExtractReasoning).toHaveBeenCalled();
      expect(mockNormalize).toHaveBeenCalledWith({
        content: "Raw response text",
        reasoningContent: "",
      });
    });

    it("extracts text from content array", () => {
      const mockExtractReasoning = ReasoningParserService.extractReasoningFromAdditionalKwargs as ReturnType<typeof vi.fn>;
      mockExtractReasoning.mockReturnValue("reasoning content");

      const mockNormalize = ReasoningNormalizerService.normalize as ReturnType<typeof vi.fn>;
      mockNormalize.mockReturnValue({ text: "combined", reasoning: "reasoning content" });

      const aiMessage: AIMessage = new AIMessage({
        content: [{ type: "text", text: "Array based response" }],
        tool_calls: [],
      });

      const result: string = extractNormalizedCronResponseText([aiMessage]);
      expect(result).toBe("combined");
    });

    it("skips non-ai messages", () => {
      const mockExtractReasoning = ReasoningParserService.extractReasoningFromAdditionalKwargs as ReturnType<typeof vi.fn>;
      mockExtractReasoning.mockReturnValue("");

      const mockNormalize = ReasoningNormalizerService.normalize as ReturnType<typeof vi.fn>;
      mockNormalize.mockReturnValue({ text: "from ai", reasoning: "" });

      const humanMessage = { _getType: () => "human" } as BaseMessage;
      const aiMessage: AIMessage = new AIMessage({
        content: "AI response",
        tool_calls: [],
      });

      const result: string = extractNormalizedCronResponseText([humanMessage, aiMessage]);
      expect(result).toBe("from ai");
    });
  });

  describe("resolveToolCallsFromAiMessage", () => {
    it("resolves tool calls from AIMessage with mocked normalizer", () => {
      const mockResolveToolCalls = ReasoningNormalizerService.resolveToolCalls as ReturnType<typeof vi.fn>;
      const resolvedCalls = [{ name: "get_cron", arguments: { taskId: "123" } }];
      mockResolveToolCalls.mockReturnValue(resolvedCalls);

      const aiMessage: AIMessage = new AIMessage({
        content: "Test content",
        tool_calls: [{ name: "get_cron", args: { taskId: "123" }, id: "call_1" }],
      });

      const result = resolveToolCallsFromAiMessage(aiMessage);
      expect(result).toEqual(resolvedCalls);
      expect(mockResolveToolCalls).toHaveBeenCalledWith(
        aiMessage.tool_calls,
        "Test content",
        {},
      );
    });

    it("passes additional_kwargs to resolveToolCalls", () => {
      const mockResolveToolCalls = ReasoningNormalizerService.resolveToolCalls as ReturnType<typeof vi.fn>;
      mockResolveToolCalls.mockReturnValue([]);

      const additionalKwargs = { reasoning_content: "some reasoning" };
      const aiMessage: AIMessage = new AIMessage({
        content: "Content",
        tool_calls: [],
        additional_kwargs: additionalKwargs,
      });

      resolveToolCallsFromAiMessage(aiMessage);
      expect(mockResolveToolCalls).toHaveBeenCalledWith([], "Content", additionalKwargs);
    });
  });
});
