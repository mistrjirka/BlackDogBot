import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";

import { compactMessagesSummaryOnlyAsync } from "../../src/utils/summarization-compaction.js";
import * as llmRetry from "../../src/utils/llm-retry.js";
import { countApprox, makeLogger } from "../utils/summarization-test-helpers.js";

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

describe("summary compaction (forced)", () => {
  beforeEach(() => {
    vi.spyOn(llmRetry, "generateTextWithRetryAsync").mockResolvedValue({
      text: "Summarized content",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns passes=0 when not forced and under target", async () => {
    const messages: ModelMessage[] = buildMessages(8, 200);
    const original: number = countApprox(messages);

    const logger = makeLogger();

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

  it("retains the newest image when L1 compacts its mixed user message", async () => {
    const imageData: Uint8Array = Uint8Array.from({ length: 9000 }, (): number => 65);
    const messages: ModelMessage[] = [
      { role: "system", content: "System instructions" },
      { role: "assistant", content: "Earlier context " + "x".repeat(1200) },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "file", data: imageData, mediaType: "image/jpeg" },
        ],
      },
    ];

    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      {} as unknown as LanguageModel,
      makeLogger(),
      1000,
      countApprox,
      true,
    );

    const latestUser = [...result.messages].reverse().find((message) => message.role === "user");
    expect(latestUser?.content).toEqual(expect.arrayContaining([
      { type: "file", data: imageData, mediaType: "image/jpeg" },
    ]));
  });

  it("performs at least one pass when forced even if under target", async () => {
    const messages: ModelMessage[] = buildMessages(12, 300);
    const original: number = countApprox(messages);

    const logger = makeLogger();

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
