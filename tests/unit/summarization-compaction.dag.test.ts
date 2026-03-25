import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

import { compactMessagesSummaryOnlyAsync } from "../../src/utils/summarization-compaction.js";
import { LoggerService } from "../../src/services/logger.service.js";
import * as llmRetry from "../../src/utils/llm-retry.js";

function countApprox(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length;
}

function makeToolMessage(toolCallId: string, text: string): ModelMessage {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId,
      output: { type: "text", value: text },
    }],
  } as ModelMessage;
}

function makeLogger(): LoggerService {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as LoggerService;
}

function buildRichConversation(): ModelMessage[] {
  return [
    { role: "system", content: "System anchor" } as ModelMessage,
    { role: "user", content: "Old request A " + "A".repeat(1200) } as ModelMessage,
    { role: "assistant", content: [{ type: "text", text: "processing A" }] } as ModelMessage,
    makeToolMessage("t-a", "tool output A " + "X".repeat(2200)),
    { role: "user", content: "LATEST USER: perform operation with id ABC123 and url https://example.com" } as ModelMessage,
    { role: "assistant", content: [{ type: "text", text: "running tools" }] } as ModelMessage,
    makeToolMessage("t-b", "tool output B " + "Y".repeat(3200)),
  ];
}

describe("summarization DAG compaction", () => {
  beforeEach(() => {
    vi.spyOn(llmRetry, "generateTextWithRetryAsync").mockResolvedValue({
      text: "Compact summary",
      usage: { inputTokens: 100, outputTokens: 20 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not execute DAG nodes when already under target", async () => {
    const messages: ModelMessage[] = [{ role: "system", content: "tiny" } as ModelMessage];
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      99999,
      countApprox,
      false,
    );

    expect(result.dagPath).toEqual([]);
    expect(result.dagTerminationReason).toBe("already_within_target");
  });

  it("stops at L1 when L1 converges and does not visit downstream nodes", async () => {
    const messages: ModelMessage[] = buildRichConversation();

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({
      text: "tiny",
      usage: { inputTokens: 100, outputTokens: 10 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);

    const target: number = Math.floor(countApprox(messages) * 0.55);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    expect(result.dagPath).toEqual(["L1"]);
    expect(result.dagNodeVisitCounts?.L2 ?? 0).toBe(0);
    expect(result.dagNodeVisitCounts?.L3 ?? 0).toBe(0);
    expect(result.dagNodeVisitCounts?.L4 ?? 0).toBe(0);
  });

  it("goes L1 -> L2 -> L4 when L2 makes no change (wrong path L3 not chosen)", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({
      text: "LONG_SUMMARY_" + "L".repeat(2500),
      usage: { inputTokens: 300, outputTokens: 250 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    expect(result.dagPath).toEqual(["L1", "L2", "L4"]);
    expect(result.dagPath?.includes("L3")).toBe(false);
  });

  it("re-enters L1 after L2 improvement (wrong path L2->L3 is not chosen)", async () => {
    const messages: ModelMessage[] = buildRichConversation();
    let nonPerToolCalls: number = 0;

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      const isPerTool: boolean = prompt.includes("Per-tool DAG compaction output");

      if (isPerTool) {
        return {
          text: "per-tool short summary",
          usage: { inputTokens: 150, outputTokens: 40 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      nonPerToolCalls++;
      const text: string = nonPerToolCalls <= 3 ? "LONG_" + "X".repeat(2600) : "tiny";
      return {
        text,
        usage: { inputTokens: 250, outputTokens: 80 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.35);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    expect(result.dagPath?.slice(0, 3)).toEqual(["L1", "L2", "L1"]);
    expect(result.dagPath?.[2]).toBe("L1");
  });

  it("uses L3 after second L1 when still over target (wrong direct L1->L4 path not chosen)", async () => {
    const messages: ModelMessage[] = buildRichConversation();

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      if (prompt.includes("Per-tool DAG compaction output")) {
        return {
          text: "L2 did not help much " + "Q".repeat(2000),
          usage: { inputTokens: 200, outputTokens: 200 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      return {
        text: "LONG_" + "Z".repeat(2800),
        usage: { inputTokens: 250, outputTokens: 180 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.30);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    const l3Index: number = (result.dagPath ?? []).indexOf("L3");
    expect(l3Index).toBeGreaterThan(0);
    expect(result.dagPath?.[l3Index - 1]).toBe("L1");
  });

  it("starts with L2 for messages.length <= 2 (L1 wrong initial path not chosen)", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      makeToolMessage("single-tool", "single huge tool output " + "T".repeat(4200)),
    ];

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({
      text: "short",
      usage: { inputTokens: 100, outputTokens: 20 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);

    const target: number = Math.floor(countApprox(messages) * 0.55);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    expect(result.dagPath?.[0]).toBe("L2");
    expect(result.dagPath?.includes("L1")).toBe(false);
  });

  it("runs DAG even under target when forced=true", async () => {
    const messages: ModelMessage[] = buildRichConversation();
    const target: number = countApprox(messages) + 5000;

    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      true,
    );

    expect((result.dagPath ?? []).length).toBeGreaterThan(0);
    expect(result.dagPath?.[0]).toBe("L1");
  });
});
