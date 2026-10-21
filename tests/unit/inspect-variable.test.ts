import { describe, expect, it } from "vitest";
import { VariableStore, wrapToolSetWithVariables } from "../../src/utils/variable-store.js";
import { createInspectVariableTool } from "../../src/tools/inspect-variable.tool.js";

const options = { toolCallId: "inspection", messages: [] };

describe("inspect_variable", () => {
  it("reads bounded portions of captured results without creating another stub", async () => {
    const store = new VariableStore();
    const evidence = "evidence ".repeat(600);
    const stub = store.maybeCapture("searxng", { results: evidence }) as { variable: string };
    const wrapped = wrapToolSetWithVariables({ inspect_variable: createInspectVariableTool(() => store) }, () => store);
    const execute = wrapped.inspect_variable.execute!;
    const first = await execute({ name: stub.variable, offset: 0, maxChars: 400 }, options) as {
      content: string; totalChars: number; nextOffset: number | null;
    };
    expect(first.content.length).toBe(400);
    expect(first.nextOffset).toBe(400);
    expect(first.totalChars).toBe(evidence.length);
    expect(store.names()).toEqual([stub.variable]);
    const second = await execute({ name: stub.variable, offset: first.nextOffset, maxChars: 400 }, options) as { content: string };
    expect(second.content).toBe(evidence.slice(400, 800));
  });

  it("reveals a search URL hidden beyond the bounded stub preview", async () => {
    const store = new VariableStore();
    const evidence = `First hit: ${"irrelevant ".repeat(300)}\nSecond hit: https://example.org/possible-leak\n${"other results ".repeat(300)}`;
    const stub = store.maybeCapture("searxng", { results: evidence }) as { variable: string; preview: string };
    expect(stub.preview).not.toContain("possible-leak");
    const tool = createInspectVariableTool(() => store);
    const result = await tool.execute!({ name: stub.variable, offset: evidence.indexOf("https://"), maxChars: 400 }, options);
    expect(result).toMatchObject({ content: expect.stringContaining("https://example.org/possible-leak") });
  });

  it("returns available names for missing or evicted variables", async () => {
    const store = new VariableStore();
    store.maybeCapture("searxng", "x".repeat(4500));
    const tool = createInspectVariableTool(() => store);
    const result = await tool.execute!({ name: "searxng_old", offset: 0, maxChars: 400 }, options);
    expect(result).toMatchObject({ error: "unknown_variable", available: ["searxng_1"] });
  });

  it("returns raw readable text from toModelOutput, not escaped JSON", () => {
    const tool = createInspectVariableTool(() => null);
    const output = {
      name: "run_cmd_1",
      offset: 0,
      totalChars: 12,
      nextOffset: null,
      content: "line one\nline two",
    };
    const modelOutput = tool.toModelOutput!({ output } as never) as { value: string };
    expect(modelOutput.value).toContain("line one\nline two");
    expect(modelOutput.value).not.toContain("\\n");
  });
});
