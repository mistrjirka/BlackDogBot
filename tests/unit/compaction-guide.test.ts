import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { attachCompactionGuide, stripCompactionGuides } from "../../src/utils/compaction-guide.js";

function history(): ModelMessage[] {
  return [
    { role: "user", content: "Compacted checkpoint" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "mcp.search", input: { query: "test" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "mcp.search", output: { type: "content", value: [{ type: "text", text: "Latest tool result" }] } }] },
  ];
}

const guide = "ACTIVE BLACKBOARD VARIABLES: mcp_search_1 (string, 9000 bytes).";

describe("compaction inventory cache stability", () => {
  it("attaches the guide to the last tool result, without editing earlier messages", () => {
    const messages = history();
    const original = JSON.stringify(messages);
    const annotated = attachCompactionGuide(messages, guide);
    expect(JSON.stringify(messages)).toBe(original);
    expect(annotated[0]).toBe(messages[0]);
    expect(annotated[1]).toBe(messages[1]);
    expect(JSON.stringify(annotated.at(-1))).toContain(guide);
    expect(JSON.stringify(annotated.at(-1))).toContain("Latest tool result");
  });

  it("does not change the prefix as new tool messages are appended", () => {
    const annotated = attachCompactionGuide(history(), guide);
    const prefix = JSON.stringify(annotated);
    const later: ModelMessage[] = [...annotated,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t2", toolName: "run_code", input: { code: "1+1" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t2", toolName: "run_code", output: { type: "text", value: "2" } }] },
    ];
    expect(JSON.stringify(later).startsWith(prefix.slice(0, -1))).toBe(true);
    expect(JSON.stringify(later).match(/BLACKDOGBOT_RUN_VARIABLES_BEGIN/g)).toHaveLength(1);
  });

  it("cleans the transient guide before session persistence", () => {
    const original = history();
    const annotated = attachCompactionGuide(original, guide);
    expect(stripCompactionGuides(annotated)).toEqual(original);
    expect(JSON.stringify(annotated)).toContain(guide);
    expect(JSON.stringify(stripCompactionGuides(annotated))).not.toContain(guide);
  });

  it("works for plain-text tool outputs", () => {
    const messages: ModelMessage[] = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "test", output: { type: "text", value: "A" } }] }];
    expect(JSON.stringify(attachCompactionGuide(messages, guide))).toContain(guide);
    expect(stripCompactionGuides(attachCompactionGuide(messages, guide))).toEqual(messages);
  });

  it("falls back to the checkpoint user message when no text tool result exists", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Checkpoint" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "test", output: { type: "json", value: { ok: true } } }] },
    ];
    const attached = attachCompactionGuide(messages, guide);
    expect(JSON.stringify(attached[0])).toContain(guide);
    expect(attached[1]).toBe(messages[1]);
    expect(stripCompactionGuides(attached)).toEqual(messages);
  });

  it("leaves messages alone when the inventory is absent", () => {
    const messages = history();
    expect(attachCompactionGuide(messages, null)).toBe(messages);
    expect(attachCompactionGuide([], guide)).toEqual([]);
  });

  it("does not mistake ordinary user content for a transient guide", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "ACTIVE BLACKBOARD VARIABLES are important to me" }];
    expect(stripCompactionGuides(messages)).toEqual(messages);
  });
});
