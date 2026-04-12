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

  it("keeps previously compacted earlier-context summary pinned", async () => {
    const pinnedSummaryText: string =
      "[EARLIER CONTEXT SUMMARY - Messages before the latest user request were compacted]\n\n" +
      "Pinned summary that should be preserved verbatim.\n\n" +
      "[END OF EARLIER CONTEXT SUMMARY]";

    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: [{ type: "text", text: pinnedSummaryText }] } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "Old assistant detail that can be summarized." }] } as ModelMessage,
      { role: "user", content: "LATEST USER: preserve id XYZ and continue" } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "working" }] } as ModelMessage,
      { role: "tool", content: [{ type: "tool-result", toolCallId: "tp", output: { type: "text", value: "latest tool output huge ".repeat(120) } }] } as ModelMessage,
    ];

    const promptsSeen: string[] = [];
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      promptsSeen.push(prompt);

      if (prompt.includes("TASK CONTRACT")) {
        return { text: "Goal: preserve id XYZ.", usage: { inputTokens: 100, outputTokens: 25 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      if (prompt.includes("Tool output")) {
        return { text: "Tool result summary", usage: { inputTokens: 120, outputTokens: 30 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      return { text: "Compact summary of non-pinned prefix.", usage: { inputTokens: 180, outputTokens: 40 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

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
      Math.floor(countApprox(messages) * 0.35),
      countApprox,
      true,
    );

    const serializedMessages: string = JSON.stringify(result.messages);
    expect(serializedMessages.includes("Pinned summary that should be preserved verbatim.")).toBe(true);

    const oneshotPrompts: string[] = promptsSeen.filter((prompt: string): boolean =>
      prompt.includes("Conversation excerpt:"),
    );
    expect(oneshotPrompts.length).toBeGreaterThan(0);
    expect(oneshotPrompts.some((prompt: string): boolean =>
      prompt.includes("Pinned summary that should be preserved verbatim."),
    )).toBe(false);
  });

  it("prioritizes fresh tool outputs over previously compacted ones", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "LATEST USER: analyze all tool outputs" } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "calling tools" }] } as ModelMessage,
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          output: {
            type: "text",
            value: "[COMPACTED TOOL RESULT]\n[COMPACTION COUNT: 1]\nALREADY_COMPACTED_HUGE ".repeat(280),
          },
        }],
      } as ModelMessage,
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "f1",
          output: {
            type: "text",
            value: "FRESH_LARGE ".repeat(240),
          },
        }],
      } as ModelMessage,
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "f2",
          output: {
            type: "text",
            value: "FRESH_MEDIUM ".repeat(200),
          },
        }],
      } as ModelMessage,
    ];

    const toolOutputPrompts: string[] = [];
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";

      if (prompt.includes("Tool output")) {
        toolOutputPrompts.push(prompt);
        return { text: "Tool summary", usage: { inputTokens: 120, outputTokens: 30 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      if (prompt.includes("TASK CONTRACT")) {
        return { text: "Task contract", usage: { inputTokens: 100, outputTokens: 25 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      return { text: "Prefix summary", usage: { inputTokens: 180, outputTokens: 40 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as LoggerService;

    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      Math.floor(countApprox(messages) * 0.18),
      countApprox,
      true,
    );

    expect(toolOutputPrompts.length).toBeGreaterThan(0);
    expect(toolOutputPrompts[0].includes("FRESH_LARGE") || toolOutputPrompts[0].includes("FRESH_MEDIUM")).toBe(true);
    expect(toolOutputPrompts[0].includes("ALREADY_COMPACTED_HUGE")).toBe(false);
  });

  it("increments tool compaction count when re-compacting a tool result", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "LATEST USER: compact this output again" } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "calling tool" }] } as ModelMessage,
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c2",
          output: {
            type: "text",
            value: "[COMPACTED TOOL RESULT]\n[COMPACTION COUNT: 1]\nALREADY_COMPACTED ".repeat(320),
          },
        }],
      } as ModelMessage,
    ];

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";

      if (prompt.includes("Tool output")) {
        return { text: "Re-compacted tool summary", usage: { inputTokens: 120, outputTokens: 30 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      if (prompt.includes("TASK CONTRACT")) {
        return { text: "Task contract", usage: { inputTokens: 100, outputTokens: 25 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      return { text: "Prefix summary", usage: { inputTokens: 180, outputTokens: 40 } } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

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
      Math.floor(countApprox(messages) * 0.2),
      countApprox,
      true,
    );

    const resultText: string = JSON.stringify(result.messages);
    expect(resultText.includes("[COMPACTION COUNT: 2]")).toBe(true);
  });

  it("skips latest-user stage when latest user is below 10% of context window", async () => {
    const messages: ModelMessage[] = buildConversation();

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as LoggerService;

    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      Math.floor(countApprox(messages) * 0.25),
      countApprox,
      true,
      {
        contextWindow: 100000,
        latestUserCompactionMinContextRatio: 0.1,
      },
    );

    expect(logger.info).toHaveBeenCalledWith(
      "Compaction stage skipped",
      expect.objectContaining({
        stage: "latest_user_message",
        reason: "below_context_ratio_threshold",
      }),
    );
  });

  it("keeps latest-user stage eligible when latest user is at least 10% of context window", async () => {
    const largeLatestUser: string = "LATEST USER: " + "Z".repeat(1800);
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "A".repeat(2000) } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "processing" }] } as ModelMessage,
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "tool output ".repeat(300) } }] } as ModelMessage,
      { role: "user", content: largeLatestUser } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "working" }] } as ModelMessage,
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t2", output: { type: "text", value: "latest tool output ".repeat(320) } }] } as ModelMessage,
    ];

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as LoggerService;

    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      Math.floor(countApprox(messages) * 0.25),
      countApprox,
      true,
      {
        contextWindow: 200,
        latestUserCompactionMinContextRatio: 0.1,
      },
    );

    const skippedCalls: unknown[] = vi.mocked(logger.info).mock.calls
      .filter((call: unknown[]) => call[0] === "Compaction stage skipped");

    const skippedForRatio: boolean = skippedCalls.some((call: unknown[]) => {
      const payload: unknown = call[1];
      return typeof payload === "object"
        && payload !== null
        && "reason" in payload
        && (payload as { reason?: string }).reason === "below_context_ratio_threshold";
    });

    expect(skippedForRatio).toBe(false);
  });
});
