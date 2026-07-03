import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

import { compactMessagesSummaryOnlyAsync } from "../../src/utils/summarization-compaction.js";
import * as llmRetry from "../../src/utils/llm-retry.js";
import { countApprox, makeLogger, makeToolMessage } from "../utils/summarization-test-helpers.js";

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

  it("goes L1 -> L2 -> L3 when L2 makes no change (L3 batched summarization attempted)", async () => {
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

    expect(result.dagPath?.slice(0, 3)).toEqual(["L1", "L2", "L3"]);
    expect(result.dagPath?.includes("L3")).toBe(true);
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

  it("engages fallback ladder L5 when DAG cannot reach tiny target", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "assistant", content: "A".repeat(5000) } as ModelMessage,
      { role: "assistant", content: "B".repeat(5000) } as ModelMessage,
      { role: "assistant", content: "C".repeat(5000) } as ModelMessage,
      { role: "assistant", content: "D".repeat(5000) } as ModelMessage,
      { role: "assistant", content: "E".repeat(5000) } as ModelMessage,
    ];

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({
      text: "LONG_" + "Z".repeat(3200),
      usage: { inputTokens: 200, outputTokens: 180 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);

    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      1,
      countApprox,
      false,
    );

    expect(result.dagPath?.includes("L5")).toBe(true);
  });

  it("routes L3→L1 when L3 improves token count", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    let l3CallCount: number = 0;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      // L3 batched summarization
      if (prompt.includes("Summarize these conversation messages")) {
        l3CallCount++;
        // Return short summary to show L3 improves
        return {
          text: "Short batch summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      // L1 and other stages return long output to force progression
      return {
        text: "LONG_" + "X".repeat(2600),
        usage: { inputTokens: 250, outputTokens: 180 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.20);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    // L3 should have been called and improved
    expect(l3CallCount).toBeGreaterThan(0);
    // After L3 improvement, DAG should route back to L1
    const l3Index: number = (result.dagPath ?? []).indexOf("L3");
    expect(l3Index).toBeGreaterThan(0);
    // The node after L3 should be L1 (re-entry after improvement)
    if (l3Index < (result.dagPath?.length ?? 0) - 1) {
      expect(result.dagPath?.[l3Index + 1]).toBe("L1");
    }
  });

  it("follows DAG path through L3 to L4 when L2 doesn't improve", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    // All stages return very long output (longer than original, so no token improvement)
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      // L3/L4 batched summarization - return VERY long text to prevent token improvement
      if (prompt.includes("Summarize these conversation messages")) {
        return {
          text: "LONG_BATCH_" + "L".repeat(8000),
          usage: { inputTokens: 300, outputTokens: 2000 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      // L1 and other stages also return long output
      return {
        text: "LONG_SUMMARY_" + "L".repeat(8000),
        usage: { inputTokens: 300, outputTokens: 2000 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.15);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    // DAG should visit L3 after L2 (even when L2 doesn't improve)
    expect(result.dagPath?.[0]).toBe("L1");
    expect(result.dagPath?.[1]).toBe("L2");
    expect(result.dagPath?.[2]).toBe("L3");
    // L3 changes messages (batch summary), so DAG re-enters L1
    // Then L1 doesn't improve, so goes to L4
    expect(result.dagPath?.includes("L4")).toBe(true);
    // Should eventually fall back to L5/L6 when all LLM stages fail
    expect(result.dagPath?.includes("L5")).toBe(true);
  });
});
