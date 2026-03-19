import { describe, it, expect, vi } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

import { compactMessagesSummaryOnlyAsync } from "../../src/utils/summarization-compaction.js";
import { LoggerService } from "../../src/services/logger.service.js";

function buildMessages(count: number, textSize: number): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: "system", content: "System instructions" },
  ];

  for (let i: number = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: ${"x".repeat(textSize)}`,
    });
  }

  return messages;
}

function countApprox(msgs: ModelMessage[]): number {
  return JSON.stringify(msgs).length;
}

describe("summary compaction (forced)", () => {
  it("returns passes=0 when not forced and under target", async () => {
    const messages: ModelMessage[] = buildMessages(8, 200);
    const original: number = countApprox(messages);

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
      original + 1000,
      countApprox,
      false,
    );

    expect(result.passes).toBe(0);
    expect(result.compactedTokens).toBe(result.originalTokens);
  });

  it("performs at least one pass when forced even if under target", async () => {
    const messages: ModelMessage[] = buildMessages(12, 300);
    const original: number = countApprox(messages);

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
      original + 1000,
      countApprox,
      true,
    );

    expect(result.passes).toBeGreaterThanOrEqual(1);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });
});
