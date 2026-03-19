import { describe, it, expect, vi } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

import { compactMessagesSummaryOnlyAsync } from "../../src/utils/summarization-compaction.js";
import { LoggerService } from "../../src/services/logger.service.js";

function countApprox(msgs: ModelMessage[]): number {
  return JSON.stringify(msgs).length;
}

function buildConversation(): ModelMessage[] {
  return [
    { role: "system", content: "System anchor" } as ModelMessage,
    { role: "user", content: "Old user request A with details" } as ModelMessage,
    { role: "assistant", content: [{ type: "text", text: "calling tools for A" }] } as ModelMessage,
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "A tool output long long long ".repeat(120) } }] } as ModelMessage,
    { role: "user", content: "Old user request B with constraints" } as ModelMessage,
    { role: "assistant", content: [{ type: "text", text: "calling tools for B" }] } as ModelMessage,
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t2", output: { type: "text", value: "B tool output long long long ".repeat(120) } }] } as ModelMessage,
    { role: "user", content: "LATEST USER: do X, keep URL https://example.com, id ABC123" } as ModelMessage,
    { role: "assistant", content: [{ type: "text", text: "work in progress" }] } as ModelMessage,
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t3", output: { type: "text", value: "latest tool output huge ".repeat(220) } }] } as ModelMessage,
  ];
}

describe("summarization compaction task-aware", () => {
  it("keeps latest user segment and compacts prefix first", async () => {
    const messages: ModelMessage[] = buildConversation();

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as LoggerService;

    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      Math.floor(countApprox(messages) * 0.45),
      countApprox,
      true,
    );

    expect(result.messages[0]).toEqual(messages[0]);

    const allText: string = JSON.stringify(result.messages);
    expect(allText.includes("LATEST USER") || allText.includes("TASK CONTRACT") || allText.includes("latest user request")).toBe(true);

    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
    expect(result.passes).toBeGreaterThanOrEqual(1);
  });

  it("forced compaction never returns no-op for sizable history", async () => {
    const messages: ModelMessage[] = buildConversation();

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as LoggerService;

    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      countApprox(messages) + 500,
      countApprox,
      true,
    );

    expect(result.passes).toBeGreaterThanOrEqual(1);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });
});
