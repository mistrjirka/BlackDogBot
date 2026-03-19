import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

import { compactMessagesSummaryOnlyAsync } from "../../src/utils/summarization-compaction.js";
import { LoggerService } from "../../src/services/logger.service.js";
import * as llmRetry from "../../src/utils/llm-retry.js";

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
  beforeEach(() => {
    vi.spyOn(llmRetry, "generateTextWithRetryAsync").mockImplementation(async (params: unknown) => {
      const prompt = (params as { prompt?: string }).prompt ?? "";

      if (prompt.includes("TASK CONTRACT")) {
        return { text: "Goal: do X. Keep URL https://example.com. Keep id ABC123.", usage: { inputTokens: 100, outputTokens: 25 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      if (prompt.includes("Tool output")) {
        return { text: "Tool result: preserved key ids/urls/errors.", usage: { inputTokens: 120, outputTokens: 30 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      return { text: "Compact summary of earlier context.", usage: { inputTokens: 180, outputTokens: 40 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("preserves tool-result structure after stage C compaction", async () => {
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
      Math.floor(countApprox(messages) * 0.25),
      countApprox,
      true,
    );

    const toolMessages: ModelMessage[] = result.messages.filter((m: ModelMessage) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);

    for (const toolMsg of toolMessages) {
      if (!Array.isArray(toolMsg.content)) {
        continue;
      }

      for (const part of toolMsg.content) {
        if (typeof part === "object" && part !== null && "type" in part) {
          const p = part as { type?: string; output?: unknown; result?: unknown };
          expect(p.type).toBe("tool-result");
          if (p.output && typeof p.output === "object" && p.output !== null && "value" in (p.output as Record<string, unknown>)) {
            const value = (p.output as { value?: unknown }).value;
            if (typeof value === "string") {
              expect(value.includes("[COMPACTED TOOL RESULT]") || value.includes("Tool result") || value.includes("long long") || value.includes("latest tool output")).toBe(true);
            }
          }
        }
      }
    }
  });
});
