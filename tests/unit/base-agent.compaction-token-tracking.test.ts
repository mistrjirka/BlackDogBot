import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";

vi.mock("../../src/utils/token-tracker.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/token-tracker.js")>(
    "../../src/utils/token-tracker.js",
  );

  return {
    ...actual,
    countTokens: vi.fn(),
    estimateRequestLikeTokens: vi.fn(),
    estimateRequestLikeTokensByBytes: vi.fn(),
  };
});

vi.mock("../../src/utils/summarization-compaction.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/summarization-compaction.js")>(
    "../../src/utils/summarization-compaction.js",
  );

  return {
    ...actual,
    compactMessagesSummaryOnlyAsync: vi.fn(),
  };
});

import { BaseAgentBase } from "../../src/agent/base-agent.js";
import type {
  IRequestLikeByteTokenEstimate,
  IRequestLikeTokenEstimate,
} from "../../src/utils/token-tracker.js";
import * as tokenTracker from "../../src/utils/token-tracker.js";
import * as summarizationCompaction from "../../src/utils/summarization-compaction.js";
import { resetSingletons } from "../utils/test-helpers.js";

class TestAgent extends BaseAgentBase {
  constructor(options?: { maxSteps?: number; contextWindow?: number }) {
    super(options);
  }

  public buildAgentPublic(model: LanguageModel, instructions: string, tools: ToolSet): void {
    this._buildAgent(model, instructions, tools);
  }

  public async callPrepareStepAsync(
    stepNumber: number,
    messages: ModelMessage[],
    steps: Array<{ usage?: { inputTokens?: number } }> = [],
  ): Promise<unknown> {
    const internalAgent = (this as unknown as {
      _agent: { settings: { prepareStep: (input: unknown) => Promise<unknown> } } | null;
    })._agent;

    if (!internalAgent?.settings?.prepareStep) {
      throw new Error("prepareStep is not available in test agent");
    }

    return internalAgent.settings.prepareStep({
      stepNumber,
      messages,
      steps,
    });
  }

  public get estimatedInputTokens(): number {
    return this._estimatedInputTokens;
  }

  public get totalInputTokens(): number {
    return this._totalInputTokens;
  }

  public get rawEstimatedInputTokens(): number {
    return this._rawEstimatedInputTokens;
  }

  public get tokenEstimateCorrectionFactor(): number {
    return this._tokenEstimateCorrectionFactor;
  }
}

describe("BaseAgentBase compaction token tracking", () => {
  beforeEach(() => {
    resetSingletons();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSingletons();
  });

  it("updates estimatedInputTokens to post-compaction value", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    const model: LanguageModel = {} as LanguageModel;

    agent.buildAgentPublic(model, "Test instructions", {});

    (agent as unknown as { _tokenEstimateCorrectionFactor: number })._tokenEstimateCorrectionFactor = 1;

    vi.mocked(tokenTracker.estimateRequestLikeTokens)
      .mockReturnValueOnce({
        breakdown: {
          total: 90_000,
          messages: 0,
          image: 0,
          tools: 0,
          system: 0,
          overhead: 0,
          messageCount: 1,
          toolCount: 0,
        },
      } as IRequestLikeTokenEstimate)
      .mockReturnValueOnce({
        breakdown: {
          total: 30_000,
          messages: 0,
          image: 0,
          tools: 0,
          system: 0,
          overhead: 0,
          messageCount: 1,
          toolCount: 0,
        },
      } as IRequestLikeTokenEstimate);

    vi.mocked(tokenTracker.estimateRequestLikeTokensByBytes)
      .mockReturnValue({
        estimatedTokens: 90_000,
        requestSizeBytes: 0,
        messageCount: 1,
        toolCount: 0,
      } as IRequestLikeByteTokenEstimate);

    vi.mocked(tokenTracker.countTokens)
      .mockReturnValueOnce(74_000)
      .mockReturnValueOnce(25_000);

    vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync)
      .mockResolvedValue({
        messages: [{ role: "system", content: "[COMPACTED]" } as ModelMessage],
        passes: 1,
        originalTokens: 74_000,
        compactedTokens: 25_000,
        converged: true,
      });

    const messages: ModelMessage[] = [
      { role: "user", content: "Long context before compaction" } as ModelMessage,
    ];

    await agent.callPrepareStepAsync(0, messages);

    expect(summarizationCompaction.compactMessagesSummaryOnlyAsync).toHaveBeenCalledOnce();
    expect(agent.totalInputTokens).toBe(30_000);
    expect(agent.estimatedInputTokens).toBe(30_000);
  });

  it("keeps estimatedInputTokens equal to totalInputTokens after compaction", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    const model: LanguageModel = {} as LanguageModel;

    agent.buildAgentPublic(model, "Test instructions", {});

    (agent as unknown as { _tokenEstimateCorrectionFactor: number })._tokenEstimateCorrectionFactor = 1;

    vi.mocked(tokenTracker.estimateRequestLikeTokens)
      .mockReturnValueOnce({
        breakdown: {
          total: 95_000,
          messages: 0,
          image: 0,
          tools: 0,
          system: 0,
          overhead: 0,
          messageCount: 1,
          toolCount: 0,
        },
      } as IRequestLikeTokenEstimate)
      .mockReturnValueOnce({
        breakdown: {
          total: 31_000,
          messages: 0,
          image: 0,
          tools: 0,
          system: 0,
          overhead: 0,
          messageCount: 1,
          toolCount: 0,
        },
      } as IRequestLikeTokenEstimate);

    vi.mocked(tokenTracker.estimateRequestLikeTokensByBytes)
      .mockReturnValue({
        estimatedTokens: 95_000,
        requestSizeBytes: 0,
        messageCount: 1,
        toolCount: 0,
      } as IRequestLikeByteTokenEstimate);

    vi.mocked(tokenTracker.countTokens)
      .mockReturnValueOnce(76_000)
      .mockReturnValueOnce(26_000);

    vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync)
      .mockResolvedValue({
        messages: [{ role: "system", content: "[COMPACTED-2]" } as ModelMessage],
        passes: 1,
        originalTokens: 76_000,
        compactedTokens: 26_000,
        converged: true,
      });

    const messages: ModelMessage[] = [
      { role: "user", content: "Second run long context" } as ModelMessage,
    ];

    await agent.callPrepareStepAsync(0, messages);

    expect(agent.totalInputTokens).toBe(31_000);
    expect(agent.estimatedInputTokens).toBe(agent.totalInputTokens);
  });

  it("updates raw token tracking and returns compacted messages", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    const model: LanguageModel = {} as LanguageModel;

    agent.buildAgentPublic(model, "Test instructions", {});

    (agent as unknown as { _tokenEstimateCorrectionFactor: number })._tokenEstimateCorrectionFactor = 1.08;

    vi.mocked(tokenTracker.estimateRequestLikeTokens)
      .mockReturnValueOnce({
        breakdown: {
          total: 90_000,
          messages: 0,
          image: 0,
          tools: 0,
          system: 0,
          overhead: 0,
          messageCount: 1,
          toolCount: 0,
        },
      } as IRequestLikeTokenEstimate)
      .mockReturnValueOnce({
        breakdown: {
          total: 30_000,
          messages: 0,
          image: 0,
          tools: 0,
          system: 0,
          overhead: 0,
          messageCount: 1,
          toolCount: 0,
        },
      } as IRequestLikeTokenEstimate);

    vi.mocked(tokenTracker.estimateRequestLikeTokensByBytes)
      .mockReturnValue({
        estimatedTokens: 90_000,
        requestSizeBytes: 0,
        messageCount: 1,
        toolCount: 0,
      } as IRequestLikeByteTokenEstimate);

    vi.mocked(tokenTracker.countTokens)
      .mockReturnValueOnce(74_000)
      .mockReturnValueOnce(25_000);

    const compactedMessages: ModelMessage[] = [
      { role: "system", content: "[COMPACTED-3]" } as ModelMessage,
    ];

    vi.mocked(summarizationCompaction.compactMessagesSummaryOnlyAsync)
      .mockResolvedValue({
        messages: compactedMessages,
        passes: 1,
        originalTokens: 74_000,
        compactedTokens: 25_000,
        converged: true,
      });

    const result = await agent.callPrepareStepAsync(0, [
      { role: "user", content: "Long context before compaction" } as ModelMessage,
    ]) as { messages: ModelMessage[] };

    expect(result.messages).toEqual(compactedMessages);
    expect(agent.rawEstimatedInputTokens).toBe(30_000);

    const expectedCorrectedTokens: number = Math.ceil(
      agent.rawEstimatedInputTokens * agent.tokenEstimateCorrectionFactor,
    );
    expect(agent.totalInputTokens).toBe(expectedCorrectedTokens);
    expect(agent.estimatedInputTokens).toBe(expectedCorrectedTokens);
  });
});
