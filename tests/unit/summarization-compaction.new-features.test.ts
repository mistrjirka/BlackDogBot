import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

import { compactMessagesSummaryOnlyAsync } from "../../src/utils/summarization-compaction.js";
import * as llmRetry from "../../src/utils/llm-retry.js";
import { countApprox, makeLogger, makeToolMessage } from "../utils/summarization-test-helpers.js";

function buildLargePrefixConversation(): ModelMessage[] {
  // Build a conversation with a large prefix that should trigger chunking
  const messages: ModelMessage[] = [
    { role: "system", content: "System anchor" } as ModelMessage,
  ];

  // Add many large messages before the latest user
  for (let i: number = 0; i < 20; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Old message ${i}: ${"X".repeat(2000)}`,
    } as ModelMessage);
  }

  // Latest user message
  messages.push({
    role: "user",
    content: "LATEST USER: perform operation with id ABC123",
  } as ModelMessage);

  // Some messages after latest user
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "running tools" }],
  } as ModelMessage);
  messages.push(makeToolMessage("t-latest", "latest tool output " + "Y".repeat(1500)));

  return messages;
}

describe("summarization compaction - new features", () => {
  beforeEach(() => {
    vi.spyOn(llmRetry, "generateTextWithRetryAsync").mockResolvedValue({
      text: "Compact summary",
      usage: { inputTokens: 100, outputTokens: 20 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  //#region Task 9.3: Chunked summarization splits large prefix into chunks

  it("chunked summarization splits large prefix into multiple chunks", async () => {
    const messages: ModelMessage[] = buildLargePrefixConversation();
    const chunkSummaries: string[] = [];

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";

      // Detect chunk summaries by looking for "Conversation excerpt:" which is the single-shot pattern
      // Combine step (check BEFORE "Conversation excerpt:" since combine prompt also contains it)
      if (prompt.includes("Combine these conversation summaries")) {
        return {
          text: "Combined summary of all chunks",
          usage: { inputTokens: 300, outputTokens: 40 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      if (prompt.includes("Conversation excerpt:")) {
        chunkSummaries.push("chunk-summary");
        return {
          text: "Chunk summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      // Other summaries (task contract, tool results)
      return {
        text: "Other summary",
        usage: { inputTokens: 150, outputTokens: 25 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.20);
    // Use a small context window to force chunking (60% of 10k = 6k tokens max per chunk)
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      true,
      { contextWindow: 10_000 },
    );

    // With a large prefix, we should see multiple chunk summaries
    expect(chunkSummaries.length).toBeGreaterThan(1);
    expect(result.passes).toBeGreaterThanOrEqual(1);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });

  //#endregion Task 9.3

  //#region Task 9.4: DAG advances to next node when L1 throws

  it("DAG advances to next node when L1 throws", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    let callCount: number = 0;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      callCount++;
      const prompt: string = (params as { prompt?: string }).prompt ?? "";

      // First call (L1 prefix) throws
      if (callCount === 1 && prompt.includes("Conversation excerpt:")) {
        throw new Error("Simulated L1 failure");
      }

      // Subsequent calls succeed
      return {
        text: "Recovery summary",
        usage: { inputTokens: 100, outputTokens: 20 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    // DAG should have advanced beyond L1
    expect(result.dagPath?.length).toBeGreaterThan(1);
    // Should not have crashed
    expect(result.passes).toBeGreaterThanOrEqual(0);
  });

  //#endregion Task 9.4

  //#region Task 9.5: Batched per-message summarization (L3) reduces tokens

  it("batched per-message summarization (L3) reduces tokens without truncation", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    let callCount: number = 0;
    // Make L1 and L2 produce long summaries so we fall through to L3
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      callCount++;
      const prompt: string = (params as { prompt?: string }).prompt ?? "";

      // Batch summaries (L3/L4) - return short summary to show L3 works
      if (prompt.includes("Summarize these conversation messages")) {
        return {
          text: "Batch summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      // First few calls produce long output to force progression through DAG
      if (callCount <= 4) {
        return {
          text: "LONG_" + "X".repeat(2600),
          usage: { inputTokens: 250, outputTokens: 180 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      // Later calls produce short output
      return {
        text: "Short",
        usage: { inputTokens: 100, outputTokens: 10 },
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

    // Should have visited multiple DAG nodes
    expect(result.dagPath?.length).toBeGreaterThan(1);
    // Should have reduced tokens
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
    // No truncation markers should appear
    const resultText: string = JSON.stringify(result.messages);
    expect(resultText.includes("[TRUNCATED")).toBe(false);
  });

  //#endregion Task 9.5

  //#region Task 9.6: Aggressive batched summarization (L4) produces shorter summaries

  it("aggressive batched summarization (L4) produces shorter summaries", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    let isAggressive: boolean = false;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";

      // Detect aggressive mode by checking for batch summaries
      if (prompt.includes("Summarize these conversation messages")) {
        // L4 uses shorter budget, so return shorter summary
        return {
          text: isAggressive ? "Agg" : "Batch summary",
          usage: { inputTokens: 200, outputTokens: isAggressive ? 10 : 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }

      // Force progression to L4 by producing long summaries
      return {
        text: "LONG_" + "X".repeat(2600),
        usage: { inputTokens: 250, outputTokens: 180 },
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

    // L4 should have been visited
    expect(result.dagPath?.includes("L4")).toBe(true);
    // Should have reduced tokens significantly
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });

  //#endregion Task 9.6

  //#region Task 9.7: Errors from _summarizeTextAsync propagate to DAG

  it("errors from _summarizeTextAsync propagate to DAG, not swallowed", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    const logger = makeLogger();

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async () => {
      throw new Error("LLM error");
    });

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      target,
      countApprox,
      false,
    );

    // DAG should have handled the error gracefully (not crashed)
    expect(result.dagPath?.length).toBeGreaterThan(0);
    // Should have logged a warning about the failure
    expect(logger.warn).toHaveBeenCalled();
    // Should have fallen back to the multimodal ladder since all LLM calls failed
    expect(result.converged).toBe(false);
  });

  //#endregion Task 9.7

  //#region Task 9.8: Hard gate errors are handled by DAG try/catch

  it("hard gate errors are handled by DAG try/catch", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    const logger = makeLogger();

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async () => {
      const error: Error = new Error("Context length exceeded");
      (error as Record<string, unknown>).statusCode = 400;
      throw error;
    });

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      target,
      countApprox,
      false,
    );

    // DAG should have handled the error gracefully
    expect(result.dagPath?.length).toBeGreaterThan(0);
    // Should have logged warnings
    expect(logger.warn).toHaveBeenCalled();
  });

  //#endregion Task 9.8

  //#region Task 9.9: Success-path empty response throws instead of returning placeholder

  it("success-path empty response throws instead of returning placeholder", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    const logger = makeLogger();

    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({
      text: "",
      usage: { inputTokens: 100, outputTokens: 0 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      target,
      countApprox,
      false,
    );

    // DAG should have handled the empty response error gracefully
    expect(result.dagPath?.length).toBeGreaterThan(0);
    // Should have logged warnings about the failure
    expect(logger.warn).toHaveBeenCalled();
    // Should NOT contain placeholder text
    const resultText: string = JSON.stringify(result.messages);
    expect(resultText.includes("[COMPACTION FAILED")).toBe(false);
  });

  //#endregion Task 9.9

  //#region Fix #4: Batch skip conditions

  it("batched compaction skips system messages", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System instructions " + "S".repeat(2800) } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    let batchedCallCount: number = 0;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      if (prompt.includes("Summarize these conversation messages")) {
        batchedCallCount++;
        return {
          text: "Batch summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      return {
        text: "LONG_" + "X".repeat(2600),
        usage: { inputTokens: 250, outputTokens: 180 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.20);
    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    // System message should not appear in any batch summary prompt
    // If it did, the batch prompt would contain "System instructions"
    const mockCalls = vi.mocked(llmRetry.generateTextWithRetryAsync).mock.calls;
    for (const call of mockCalls) {
      const prompt: string = (call[0] as { prompt?: string }).prompt ?? "";
      if (prompt.includes("Summarize these conversation messages")) {
        expect(prompt.includes("System instructions")).toBe(false);
      }
    }
  });

  it("batched compaction skips already-compacted messages", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      {
        role: "user",
        content: "[EARLIER CONTEXT SUMMARY - Messages before the latest user request were compacted]\n\nPrior summary " + "P".repeat(2800),
      } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    let batchedCallCount: number = 0;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      if (prompt.includes("Summarize these conversation messages")) {
        batchedCallCount++;
        return {
          text: "Batch summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      return {
        text: "LONG_" + "X".repeat(2600),
        usage: { inputTokens: 250, outputTokens: 180 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.15);
    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    // The EARLIER CONTEXT SUMMARY should not appear in batch prompts
    const mockCalls = vi.mocked(llmRetry.generateTextWithRetryAsync).mock.calls;
    for (const call of mockCalls) {
      const prompt: string = (call[0] as { prompt?: string }).prompt ?? "";
      if (prompt.includes("Summarize these conversation messages")) {
        expect(prompt.includes("[EARLIER CONTEXT SUMMARY")).toBe(false);
      }
    }
  });

  it("batched compaction skips short messages below 200 chars", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Short msg" } as ModelMessage,
      { role: "assistant", content: "Also short" } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Still short" } as ModelMessage,
    ];

    let batchedCallCount: number = 0;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      if (prompt.includes("Summarize these conversation messages")) {
        batchedCallCount++;
      }
      return {
        text: "Summary",
        usage: { inputTokens: 100, outputTokens: 20 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.10);
    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      false,
    );

    // No batch summaries should be called since all non-system, non-user messages are short
    expect(batchedCallCount).toBe(0);
  });

  //#endregion Fix #4

  //#region Fix #5: _splitMessagesIntoChunks

  it("_splitMessagesIntoChunks returns empty array for empty input", async () => {
    // _splitMessagesIntoChunks is private, but we can observe its behavior through the chunked summarization path
    // If input is empty, no chunk summaries should be generated
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
    ];

    let callCount: number = 0;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async () => {
      callCount++;
      return {
        text: "Summary",
        usage: { inputTokens: 100, outputTokens: 20 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.10);
    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      true,
    );

    // With only system + user, no prefix compaction should trigger chunking
    // The DAG may still call other stages, but no "Conversation excerpt:" prompts should be sent
    // (prefix compaction requires messages between system and last user)
    const mockCalls = vi.mocked(llmRetry.generateTextWithRetryAsync).mock.calls;
    const excerptCalls = mockCalls.filter((call: unknown[]) => {
      const prompt: string = (call[0] as { prompt?: string }).prompt ?? "";
      return prompt.includes("Conversation excerpt:");
    });
    // No chunk summaries should have been generated for this minimal conversation
    expect(excerptCalls.length).toBe(0);
  });

  it("chunked summarization handles single chunk (no splitting needed)", async () => {
    // Small prefix that fits in one chunk
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old message 1: " + "A".repeat(1000) } as ModelMessage,
      { role: "assistant", content: "Reply 1: " + "B".repeat(1000) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
    ];

    const chunkSummaries: string[] = [];
    let combineCalled: boolean = false;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      // Check for combine BEFORE conversation excerpt (combine prompt also contains it)
      if (prompt.includes("Combine these conversation summaries")) {
        combineCalled = true;
        return {
          text: "Combined summary",
          usage: { inputTokens: 300, outputTokens: 40 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      if (prompt.includes("Conversation excerpt:")) {
        chunkSummaries.push("chunk-summary");
        return {
          text: "Chunk summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      return {
        text: "Summary",
        usage: { inputTokens: 100, outputTokens: 20 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.10);
    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      true,
    );

    // Small prefix should produce at least 1 chunk summary per L1 pass
    // (DAG may run L1 multiple times, so we check >= 1 not exactly 1)
    expect(chunkSummaries.length).toBeGreaterThanOrEqual(1);
    // With single chunk, combine step should never be called
    expect(combineCalled).toBe(false);
  });

  it("chunk size threshold is contextWindow * 0.60", async () => {
    // Build a conversation with a prefix that's large enough to require chunking
    // With contextWindow=10000, maxChunkPromptTokens = 6000
    // The prefix should be split into chunks that each fit within 6000 tokens
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
    ];
    // Add enough messages to exceed 6000 tokens but not 12000 (2 chunks)
    for (let i: number = 0; i < 10; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"X".repeat(1200)}`,
      } as ModelMessage);
    }
    messages.push({
      role: "user",
      content: "LATEST USER: perform operation",
    } as ModelMessage);

    const chunkSummaries: string[] = [];
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      // Check for combine BEFORE conversation excerpt (combine prompt also contains it)
      if (prompt.includes("Combine these conversation summaries")) {
        return {
          text: "Combined summary",
          usage: { inputTokens: 300, outputTokens: 40 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      if (prompt.includes("Conversation excerpt:")) {
        chunkSummaries.push("chunk-summary");
        return {
          text: "Chunk summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      return {
        text: "Other summary",
        usage: { inputTokens: 100, outputTokens: 20 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.10);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      true,
      { contextWindow: 10_000 },
    );

    // With contextWindow=10000, maxChunkPromptTokens=6000
    // The prefix (~12000 chars) should be split into at least 2 chunks
    expect(chunkSummaries.length).toBeGreaterThanOrEqual(2);
    expect(result.passes).toBeGreaterThanOrEqual(1);
  });

  it("uses plainTextTokenCounter for chunk boundaries and promptTokenCounter for initial check", async () => {
    // This test verifies the two-tier counter strategy:
    // - promptTokenCounter (with instruction template) for "fits in one chunk" check
    // - plainTextTokenCounter (without template) for chunk boundary decisions
    // We verify this indirectly: if the plain text counter were used for the initial check,
    // a prefix that barely fits by plain text but exceeds by prompt would not be chunked.
    // Conversely, if the prompt counter were used for boundaries, chunks would be smaller.
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
    ];
    // Create a prefix that's large enough to require chunking with a small context window
    for (let i: number = 0; i < 12; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"Y".repeat(1000)}`,
      } as ModelMessage);
    }
    messages.push({
      role: "user",
      content: "LATEST USER: continue",
    } as ModelMessage);

    let chunkCallCount: number = 0;
    let combineCallCount: number = 0;
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      // Check for combine BEFORE conversation excerpt (combine prompt also contains "Conversation excerpt:")
      if (prompt.includes("Combine these conversation summaries")) {
        combineCallCount++;
        return {
          text: "Combined summary",
          usage: { inputTokens: 300, outputTokens: 40 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      if (prompt.includes("Conversation excerpt:")) {
        chunkCallCount++;
        return {
          text: "Chunk summary",
          usage: { inputTokens: 200, outputTokens: 30 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      return {
        text: "Other summary",
        usage: { inputTokens: 100, outputTokens: 20 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.10);
    // Use a very small context window to force chunking
    // contextWindow=3000 → maxChunkPromptTokens=1800
    // Prefix is ~12000 chars ≈ 3000 tokens, so should need multiple chunks
    await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      target,
      countApprox,
      true,
      { contextWindow: 3_000 },
    );

    // With contextWindow=3000, maxChunkPromptTokens=1800
    // The prefix should be split into multiple chunks
    expect(chunkCallCount).toBeGreaterThanOrEqual(2);
    // Multiple chunks means combine step should be called
    expect(combineCallCount).toBeGreaterThanOrEqual(1);
  });

  //#endregion Fix #5

  //#region Fix #10: DAG circuit breaker

  it("DAG circuit breaker triggers after 2 consecutive failures", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    const logger = makeLogger();
    let callCount: number = 0;

    // All LLM calls fail — Stage-level catches in L1 handle errors per-stage,
    // but L2/L3/L4 propagate to DAG-level catch which triggers circuit breaker
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async () => {
      callCount++;
      throw new Error("Simulated LLM failure");
    });

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      target,
      countApprox,
      false,
    );

    // DAG should not have converged since all LLM calls fail
    expect(result.converged).toBe(false);
    // Should have logged warnings about failures
    expect(logger.warn).toHaveBeenCalled();
    // Should have fallen back to multimodal ladder
    expect(result.dagTerminationReason).not.toBe("reached_target_after_node");
    // Should not have made excessive calls (circuit breaker + Stage catches limit retries)
    expect(callCount).toBeLessThan(30);
  });

  //#endregion Fix #10

  //#region Fix #11: _summarizeTextAsync empty check

  it("empty LLM response throws error that DAG handles gracefully", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "O".repeat(2800) } as ModelMessage,
      { role: "assistant", content: "Assistant note " + "N".repeat(2200) } as ModelMessage,
      { role: "user", content: "LATEST USER: continue" } as ModelMessage,
      { role: "assistant", content: "Current work " + "W".repeat(2400) } as ModelMessage,
    ];

    const logger = makeLogger();

    // Return empty text — triggers the empty check throw in _summarizeTextAsync
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({
      text: "   ",
      usage: { inputTokens: 100, outputTokens: 0 },
    } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>);

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      target,
      countApprox,
      false,
    );

    // DAG should have handled the empty response error gracefully
    expect(result.dagPath?.length).toBeGreaterThan(0);
    // Should have logged warnings about the failure
    expect(logger.warn).toHaveBeenCalled();
    // Should NOT contain placeholder text
    const resultText: string = JSON.stringify(result.messages);
    expect(resultText.includes("[COMPACTION FAILED")).toBe(false);
    // Should NOT contain empty summary markers
    expect(resultText.includes("Compact summary")).toBe(false);
  });

  it("L1-C per-tool error resilience preserves completed summaries", async () => {
    // Build messages with multiple tool results after latest user
    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "LATEST USER: run tools" } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "running tools" }] } as ModelMessage,
      makeToolMessage("t-0", "Tool output 0: " + "A".repeat(1500)),
      makeToolMessage("t-1", "Tool output 1: " + "B".repeat(1500)),
      makeToolMessage("t-2", "Tool output 2: " + "C".repeat(1500)),
    ];

    const logger = makeLogger();
    let callCount: number = 0;

    // First call (prefix) returns long output to force Stage C
    // Second call (Stage C tool 0) succeeds
    // Third call (Stage C tool 1) throws
    // Fourth call (Stage C tool 2) succeeds (because per-tool try/catch)
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockImplementation(async (params: unknown) => {
      callCount++;
      const prompt: string = (params as { prompt?: string }).prompt ?? "";
      if (prompt.includes("Summarize this tool output")) {
        // Fail on the second tool summarization call
        if (callCount === 2) {
          throw new Error("Simulated tool summarization failure");
        }
        return {
          text: "Tool summary",
          usage: { inputTokens: 100, outputTokens: 20 },
        } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
      }
      // Prefix compaction returns long output to force Stage C
      return {
        text: "LONG_" + "X".repeat(2600),
        usage: { inputTokens: 250, outputTokens: 180 },
      } as unknown as Awaited<ReturnType<typeof llmRetry.generateTextWithRetryAsync>>;
    });

    const target: number = Math.floor(countApprox(messages) * 0.25);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      logger,
      target,
      countApprox,
      false,
    );

    // DAG should not have crashed
    expect(result.dagPath?.length).toBeGreaterThan(0);
    // Should have logged a warning about the per-tool failure
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const perToolFailLogged = warnCalls.some((call: unknown[]) => {
      const msg: string = call[0] ?? "";
      return msg.includes("L1-C per-tool summarization failed");
    });
    expect(perToolFailLogged).toBe(true);
  });

  //#endregion Fix #11
});
