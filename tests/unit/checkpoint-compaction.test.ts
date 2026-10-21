import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";

vi.mock("../../src/utils/llm-retry.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/llm-retry.js")>(
    "../../src/utils/llm-retry.js",
  );

  return {
    ...actual,
    generateTextWithRetryAsync: vi.fn(),
    generateObjectWithRetryAsync: vi.fn(),
  };
});

import {
  CheckpointCompactionError,
  compactWithCheckpointAsync,
  findCheckpointCutoff,
} from "../../src/utils/checkpoint-compaction.js";
import * as llmRetry from "../../src/utils/llm-retry.js";
import type { LoggerService } from "../../src/services/logger.service.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as LoggerService;

const model = {} as LanguageModel;
const tools: ToolSet = {};

function countTokens(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length;
}

function buildHistory(): ModelMessage[] {
  return [
    { role: "user", content: "Explore the park" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will look around." },
        { type: "tool-call", toolCallId: "call-1", toolName: "look", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "look",
          output: { type: "text", value: "telephone, lighthouse, fortune" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Now I will write the driver." },
        { type: "tool-call", toolCallId: "call-2", toolName: "write_file", input: { path: "/tmp/park.py" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "write_file",
          output: { type: "text", value: "written" },
        },
      ],
    },
  ];
}

describe("findCheckpointCutoff", () => {
  it("keeps the last assistant tool-call and its trailing results", () => {
    const messages: ModelMessage[] = buildHistory();
    expect(findCheckpointCutoff(messages)).toBe(3);
  });

  it("falls back to the last user message when no tool cycle exists", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "second" },
      { role: "assistant", content: "hi" },
    ];
    expect(findCheckpointCutoff(messages)).toBe(2);
  });
});

describe("compactWithCheckpointAsync", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("summarizes the prefix with the same instructions/tools and toolChoice none", async () => {
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({ text: "plain summary" });

    const messages: ModelMessage[] = buildHistory();
    const result = await compactWithCheckpointAsync({
      messages,
      model,
      logger,
      instructions: "SYSTEM PROMPT",
      tools,
      activeTools: ["look", "write_file"],
      countTokens,
      structuredMode: "tool_emulated",
      supportsVision: false,
      archiveDir: null,
    });

    expect(llmRetry.generateTextWithRetryAsync).toHaveBeenCalledOnce();
    const call = vi.mocked(llmRetry.generateTextWithRetryAsync).mock.calls[0][0];
    expect(call.system).toBe("SYSTEM PROMPT");
    expect(call.tools).toBe(tools);
    expect(call.toolChoice).toBe("none");
    expect(call.activeTools).toEqual(["look", "write_file"]);
    expect(call.messages).toHaveLength(4); // prefix 3 + instruction
    expect(result.messages).toHaveLength(3); // summary + preserved 2
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("plain summary");
    expect(result.messages[1]).toEqual(messages[3]);
    expect(result.messages[2]).toEqual(messages[4]);
  });

  it("uses native structured output when available and falls back to plain text on failure", async () => {
    vi.mocked(llmRetry.generateObjectWithRetryAsync).mockRejectedValueOnce(new Error("no native schema"));
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({ text: "fallback summary" });

    const result = await compactWithCheckpointAsync({
      messages: buildHistory(),
      model,
      logger,
      instructions: "SYSTEM PROMPT",
      tools,
      countTokens,
      structuredMode: "native_json_schema",
      supportsVision: false,
      archiveDir: null,
    });

    expect(llmRetry.generateObjectWithRetryAsync).toHaveBeenCalledOnce();
    expect(llmRetry.generateTextWithRetryAsync).toHaveBeenCalledOnce();
    expect(result.messages[0].content).toContain("fallback summary");
  });

  it("throws when plain-text summary fails instead of truncating deterministically", async () => {
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockRejectedValue(new Error("provider down"));

    await expect(
      compactWithCheckpointAsync({
        messages: buildHistory(),
        model,
        logger,
        instructions: "SYSTEM PROMPT",
        tools,
        countTokens,
        structuredMode: "tool_emulated",
      supportsVision: false,
        archiveDir: null,
      }),
    ).rejects.toBeInstanceOf(CheckpointCompactionError);
  });

  it("throws when the plain-text summary is empty", async () => {
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({ text: "   " });

    await expect(
      compactWithCheckpointAsync({
        messages: buildHistory(),
        model,
        logger,
        instructions: "SYSTEM PROMPT",
        tools,
        countTokens,
        structuredMode: "tool_emulated",
      supportsVision: false,
        archiveDir: null,
      }),
    ).rejects.toBeInstanceOf(CheckpointCompactionError);
  });

  it("preserves the latest user image and text in the checkpoint message", async () => {
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({ text: "summary with image" });

    const image = { type: "image" as const, image: new Uint8Array([1, 2, 3]), mediaType: "image/png" };
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "What is in this screenshot?" }, image] },
      ...buildHistory().slice(1),
    ];

    const result = await compactWithCheckpointAsync({
      messages,
      model,
      logger,
      instructions: "SYSTEM PROMPT",
      tools,
      countTokens,
      structuredMode: "tool_emulated",
      supportsVision: true,
      archiveDir: null,
    });

    const content = result.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("expected multimodal summary content");
    }

    expect(content[0]).toMatchObject({ type: "text" });
    expect((content[0] as { text: string }).text).toContain("What is in this screenshot?");
    expect(content.some((part: unknown): boolean => (part as { type?: string }).type === "image")).toBe(true);
  });

  it("omits images when the active model has no vision support", async () => {
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({ text: "summary without image" });

    const image = { type: "image" as const, image: new Uint8Array([1, 2, 3]), mediaType: "image/png" };
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "What is in this screenshot?" }, image] },
      ...buildHistory().slice(1),
    ];

    const result = await compactWithCheckpointAsync({
      messages,
      model,
      logger,
      instructions: "SYSTEM PROMPT",
      tools,
      countTokens,
      structuredMode: "tool_emulated",
      supportsVision: false,
      archiveDir: null,
    });

    const content = result.messages[0].content;
    expect(typeof content).toBe("string");
    expect(content).toContain("IMAGES FROM THE ORIGINAL USER REQUEST WERE OMITTED");
  });

  it("does not treat a [STEER] message as the latest user request", async () => {
    vi.mocked(llmRetry.generateTextWithRetryAsync).mockResolvedValue({ text: "summary" });

    const messages: ModelMessage[] = [
      { role: "user", content: "real task goal" },
      ...buildHistory().slice(1),
      { role: "user", content: "[STEER] correction for the current run" },
    ];

    const result = await compactWithCheckpointAsync({
      messages,
      model,
      logger,
      instructions: "SYSTEM PROMPT",
      tools,
      countTokens,
      structuredMode: "tool_emulated",
      supportsVision: false,
      archiveDir: null,
    });

    expect(result.messages[0].content).toContain("real task goal");
    expect(result.messages[0].content).not.toContain("[STEER]");
  });
});
