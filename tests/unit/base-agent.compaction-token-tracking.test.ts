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

vi.mock("../../src/utils/checkpoint-compaction.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/checkpoint-compaction.js")>(
    "../../src/utils/checkpoint-compaction.js",
  );

  return {
    ...actual,
    compactWithCheckpointAsync: vi.fn(),
  };
});

import { BaseAgentBase } from "../../src/agent/base-agent.js";
import { VariableStore } from "../../src/utils/variable-store.js";
import { stripCompactionGuides } from "../../src/utils/compaction-guide.js";
import type {
  IRequestLikeByteTokenEstimate,
  IRequestLikeTokenEstimate,
} from "../../src/utils/token-tracker.js";
import * as tokenTracker from "../../src/utils/token-tracker.js";
import * as checkpointCompaction from "../../src/utils/checkpoint-compaction.js";
import { resetSingletons } from "../utils/test-helpers.js";
import { privateOf, setPrivate } from "../utils/casts.js";

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
    const internalAgent = privateOf<{
      _agent: { settings: { prepareStep: (input: unknown) => Promise<unknown> } } | null;
    }>(this)._agent;

    if (!internalAgent?.settings?.prepareStep) {
      throw new Error("prepareStep is not available in test agent");
    }

    return internalAgent.settings.prepareStep({
      stepNumber,
      messages,
      steps,
    });
  }

  public setStore(store: VariableStore | null): void {
    this._currentVariableStore = store;
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

  it("supplies live blackboard names after checkpoint compaction without persisting them", async () => {
    const agent = new TestAgent({ contextWindow: 100_000 });
    agent.buildAgentPublic({} as LanguageModel, "Test instructions", {});
    setPrivate<{ _tokenEstimateCorrectionFactor: number }>(agent, "_tokenEstimateCorrectionFactor", 1);
    const store = new VariableStore();
    const stub = store.maybeCapture("mcp.searxng.search", "NOT_FOR_SUMMARY_".repeat(350)) as { variable: string };
    agent.setStore(store);
    const saved: ModelMessage[][] = [];
    agent.setMessagesSink((messages: ModelMessage[]) => saved.push(messages));
    vi.mocked(tokenTracker.estimateRequestLikeTokens)
      .mockReturnValueOnce({ breakdown: { total: 90_000 } } as IRequestLikeTokenEstimate)
      .mockReturnValue({ breakdown: { total: 2000 } } as IRequestLikeTokenEstimate);
    vi.mocked(tokenTracker.estimateRequestLikeTokensByBytes).mockReturnValue({ estimatedTokens: 2000 } as IRequestLikeByteTokenEstimate);
    vi.mocked(tokenTracker.countTokens).mockReturnValue(1200);
    const compacted = [{ role: "user", content: "[COMPACTED SUMMARY]" } as ModelMessage];
    vi.mocked(checkpointCompaction.compactWithCheckpointAsync).mockResolvedValue({
      messages: compacted, passes: 1, originalTokens: 80000, compactedTokens: 1200,
      converged: true, dagPath: [], dagNodeVisitCounts: {}, dagTerminationReason: "checkpoint_plain_text", maxLevelReached: "L1",
    });
    const result = await agent.callPrepareStepAsync(0, [{ role: "user", content: "input" }]) as { messages: ModelMessage[]; instructions: string };
    expect(stripCompactionGuides(result.messages)).toEqual(compacted);
    expect(JSON.stringify(result.messages)).toContain(stub.variable);
    expect(JSON.stringify(result.messages)).not.toContain("NOT_FOR_SUMMARY");
    expect(result.instructions).toBe("Test instructions");
    expect(saved.at(-1)).toEqual(result.messages);
    const later = await agent.callPrepareStepAsync(1, result.messages) as { instructions: string };
    expect(later.instructions).toBe(result.instructions);
    expect(store.get(stub.variable)).toBe("NOT_FOR_SUMMARY_".repeat(350));
    agent.setStore(new VariableStore());
    const nextTurn = await agent.callPrepareStepAsync(2, stripCompactionGuides(result.messages)) as { instructions: string };
    expect(nextTurn.instructions).toBe(result.instructions);
    expect(JSON.stringify(stripCompactionGuides(result.messages))).not.toContain(stub.variable);
  });

  it("updates estimatedInputTokens to post-compaction value", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    const model: LanguageModel = {} as LanguageModel;

    agent.buildAgentPublic(model, "Test instructions", {});

    setPrivate<{ _tokenEstimateCorrectionFactor: number }>(agent, "_tokenEstimateCorrectionFactor", 1);

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

    vi.mocked(checkpointCompaction.compactWithCheckpointAsync)
      .mockResolvedValue({
        messages: [{ role: "system", content: "[COMPACTED]" } as ModelMessage],
        passes: 1,
        originalTokens: 74_000,
        compactedTokens: 25_000,
        converged: true,
        dagPath: [],
        dagNodeVisitCounts: {},
        dagTerminationReason: "checkpoint_plain_text",
        maxLevelReached: "L1",
      });

    const messages: ModelMessage[] = [
      { role: "user", content: "Long context before compaction" } as ModelMessage,
    ];

    await agent.callPrepareStepAsync(0, messages);

    expect(checkpointCompaction.compactWithCheckpointAsync).toHaveBeenCalledOnce();
    expect(agent.totalInputTokens).toBe(30_000);
    expect(agent.estimatedInputTokens).toBe(30_000);
  });

  it("keeps estimatedInputTokens equal to totalInputTokens after compaction", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    const model: LanguageModel = {} as LanguageModel;

    agent.buildAgentPublic(model, "Test instructions", {});

    setPrivate<{ _tokenEstimateCorrectionFactor: number }>(agent, "_tokenEstimateCorrectionFactor", 1);

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

    vi.mocked(checkpointCompaction.compactWithCheckpointAsync)
      .mockResolvedValue({
        messages: [{ role: "system", content: "[COMPACTED-2]" } as ModelMessage],
        passes: 1,
        originalTokens: 76_000,
        compactedTokens: 26_000,
        converged: true,
        dagPath: [],
        dagNodeVisitCounts: {},
        dagTerminationReason: "checkpoint_plain_text",
        maxLevelReached: "L1",
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

    setPrivate<{ _tokenEstimateCorrectionFactor: number }>(agent, "_tokenEstimateCorrectionFactor", 1.08);

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

    vi.mocked(checkpointCompaction.compactWithCheckpointAsync)
      .mockResolvedValue({
        messages: compactedMessages,
        passes: 1,
        originalTokens: 74_000,
        compactedTokens: 25_000,
        converged: true,
        dagPath: [],
        dagNodeVisitCounts: {},
        dagTerminationReason: "checkpoint_plain_text",
        maxLevelReached: "L1",
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

  it("uses one 90% trigger and does not compact below it", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    const model: LanguageModel = {} as LanguageModel;
    agent.buildAgentPublic(model, "Test instructions", {});
    setPrivate<{ _tokenEstimateCorrectionFactor: number }>(agent, "_tokenEstimateCorrectionFactor", 1);

    vi.mocked(tokenTracker.estimateRequestLikeTokens).mockReturnValue({
      breakdown: {
        total: 89_999,
        messages: 72_000,
        image: 0,
        tools: 10_000,
        system: 0,
        overhead: 7_999,
        messageCount: 84,
        toolCount: 51,
      },
    } as IRequestLikeTokenEstimate);
    vi.mocked(tokenTracker.estimateRequestLikeTokensByBytes).mockReturnValue({
      estimatedTokens: 89_999,
      requestSizeBytes: 0,
      messageCount: 84,
      toolCount: 51,
    } as IRequestLikeByteTokenEstimate);
    vi.mocked(tokenTracker.countTokens).mockReturnValue(72_000);

    await agent.callPrepareStepAsync(0, [
      { role: "user", content: "Just below the trigger" } as ModelMessage,
    ]);

    expect(checkpointCompaction.compactWithCheckpointAsync).not.toHaveBeenCalled();
  });

  it("triggers at exactly 90% of the context window", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    const model: LanguageModel = {} as LanguageModel;
    agent.buildAgentPublic(model, "Test instructions", {});
    setPrivate<{ _tokenEstimateCorrectionFactor: number }>(agent, "_tokenEstimateCorrectionFactor", 1);

    vi.mocked(tokenTracker.estimateRequestLikeTokens)
      .mockReturnValueOnce({
        breakdown: {
          total: 90_000,
          messages: 72_000,
          image: 0,
          tools: 10_000,
          system: 0,
          overhead: 8_000,
          messageCount: 84,
          toolCount: 51,
        },
      } as IRequestLikeTokenEstimate)
      .mockReturnValueOnce({
        breakdown: {
          total: 30_000,
          messages: 20_000,
          image: 0,
          tools: 10_000,
          system: 0,
          overhead: 0,
          messageCount: 4,
          toolCount: 51,
        },
      } as IRequestLikeTokenEstimate);
    vi.mocked(tokenTracker.estimateRequestLikeTokensByBytes).mockReturnValue({
      estimatedTokens: 90_000,
      requestSizeBytes: 0,
      messageCount: 84,
      toolCount: 51,
    } as IRequestLikeByteTokenEstimate);
    vi.mocked(tokenTracker.countTokens).mockReturnValueOnce(72_000).mockReturnValueOnce(20_000);

    vi.mocked(checkpointCompaction.compactWithCheckpointAsync).mockResolvedValue({
      messages: [{ role: "user", content: "[COMPACTED]" } as ModelMessage],
      passes: 1,
      originalTokens: 72_000,
      compactedTokens: 20_000,
      converged: true,
      dagPath: [],
      dagNodeVisitCounts: {},
      dagTerminationReason: "checkpoint_plain_text",
      maxLevelReached: "L1",
    });

    await agent.callPrepareStepAsync(0, [
      { role: "user", content: "At the trigger" } as ModelMessage,
    ]);

    expect(checkpointCompaction.compactWithCheckpointAsync).toHaveBeenCalledOnce();
  });

  it("captures the latest prepareStep messages through the messages sink", async () => {
    const agent: TestAgent = new TestAgent({ contextWindow: 100_000 });
    agent.buildAgentPublic({} as LanguageModel, "Test instructions", {});
    const captured: ModelMessage[][] = [];
    agent.setMessagesSink((messages: ModelMessage[]): void => {
      captured.push(messages);
    });

    vi.mocked(tokenTracker.estimateRequestLikeTokens).mockReturnValue({
      breakdown: {
        total: 1,
        messages: 0,
        image: 0,
        tools: 0,
        system: 0,
        overhead: 0,
        messageCount: 1,
        toolCount: 0,
      },
    } as IRequestLikeTokenEstimate);
    vi.mocked(tokenTracker.estimateRequestLikeTokensByBytes).mockReturnValue({
      estimatedTokens: 1,
      requestSizeBytes: 0,
      messageCount: 1,
      toolCount: 0,
    } as IRequestLikeByteTokenEstimate);
    vi.mocked(tokenTracker.countTokens).mockReturnValue(1);

    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
    await agent.callPrepareStepAsync(0, messages);

    expect(captured[0]).toEqual(messages);
  });
});
