import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";
import { compactWithCheckpointAsync } from "../../src/utils/checkpoint-compaction.js";
import * as llm from "../../src/utils/llm-retry.js";
import { makeLoggerMock } from "../utils/casts.js";

vi.mock("../../src/utils/llm-retry.js", async () => {
  const base = await vi.importActual<typeof import("../../src/utils/llm-retry.js")>("../../src/utils/llm-retry.js");
  return { ...base, generateTextWithRetryAsync: vi.fn(), generateObjectWithRetryAsync: vi.fn() };
});
const model = {} as LanguageModel;
const next = (messages: ModelMessage[], id: string): ModelMessage[] => [
  ...messages,
  { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "look", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "look", output: { type: "text", value: "One brick per key; others rejected" } }] },
];
const compact = (messages: ModelMessage[], preferPlainText = true) => compactWithCheckpointAsync({
  messages, model, logger: makeLoggerMock(), instructions: "System", tools: {},
  countTokens: (msgs) => JSON.stringify(msgs).length,
  structuredMode: "native_json_schema", preferPlainText,
  supportsVision: false, archiveDir: null,
});

describe("user intent across repeated compactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llm.generateTextWithRetryAsync).mockResolvedValue({ text: "GOAL: lay remaining 11 bricks (model plan)" });
  });

  it("keeps the literal original request across three compactions", async () => {
    const original = "Do you remember how we went to a park?";
    const first = await compact(next([{ role: "user", content: original }], "a"));
    const second = await compact(next(first.messages, "b"));
    const third = await compact(next(second.messages, "c"));
    for (const result of [first, second, third]) expect(JSON.stringify(result.messages[0])).toContain(original);
    expect(llm.generateObjectWithRetryAsync).not.toHaveBeenCalled();
  });

  it("keeps original goal even when a prior checkpoint inferred an incompatible plan", async () => {
    const old = "[EARLIER CONTEXT SUMMARY - checkpoint]\nGOAL: finish lighthouse\n[END OF EARLIER CONTEXT SUMMARY]\n\n[LATEST USER REQUEST]\nDo you remember the park?";
    const result = await compact(next([{ role: "user", content: old }], "x"));
    expect(JSON.stringify(result.messages[0])).toContain("Do you remember the park?");
  });

  it("preserves exact user steering across repeated compactions", async () => {
    const first = await compact(next([
      { role: "user", content: "Remember our park visit" },
      { role: "user", content: "[STEER] How is it going? Give me a report now." },
    ], "a"));
    expect(JSON.stringify(first.messages[0])).toContain("How is it going? Give me a report now.");
    const second = await compact(next(first.messages, "b"));
    expect(JSON.stringify(second.messages[0])).toContain("How is it going? Give me a report now.");
    expect(JSON.stringify(second.messages[0])).toContain("Remember our park visit");
  });

  it("allows structured output when thinking is explicitly disabled", async () => {
    vi.mocked(llm.generateObjectWithRetryAsync).mockResolvedValue({ object: {
      goal: "Task", currentState: "State", completed: [], remaining: [], blockers: [],
      doNotRepeat: [], artifacts: [], visualContext: "None", nextStep: "Report",
    } } as never);
    await compact(next([{ role: "user", content: "Task" }], "x"), false);
    expect(llm.generateObjectWithRetryAsync).toHaveBeenCalledOnce();
  });
});
