import { describe, expect, it } from "vitest";
import { VariableStore, wrapToolSetWithVariables } from "../../src/utils/variable-store.js";
import { createInspectVariableTool } from "../../src/tools/inspect-variable.tool.js";

const options = { toolCallId: "inspection", messages: [] };

describe("inspect_variable", () => {

  it("repairs a persisted isolated surrogate only in model-visible text", async () => {
    const store = new VariableStore();
    const original = "a".repeat(4799) + "\uD83C\uDF3F" + "b".repeat(7773);
    const parent = store.maybeCapture("source", original, true) as { variable: string };
    const derived = original.slice(4800);
    const stub = store.maybeCapture("code", derived, true, undefined, "derived", parent.variable) as { variable: string };
    const restored = VariableStore.fromSnapshot(JSON.parse(JSON.stringify(store.snapshot())));
    const tool = createInspectVariableTool(() => restored);
    const output = await tool.execute!({ name: stub.variable, offset: 0, maxChars: 3000 }, options) as {
      content: string; totalChars: number; nextOffset: number | null;
    };
    expect(restored.get(stub.variable)).toBe(derived);
    expect(output.content).toBe(derived.slice(0, 3000));
    expect(output).toMatchObject({ totalChars: 7774, nextOffset: 3000 });
    const modelOutput = tool.toModelOutput!({ output } as never) as { value: string };
    expect(modelOutput.value).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(modelOutput.value).toContain("\uFFFD" + "b".repeat(2999));
  });

  it("repairs either surrogate cut boundary without changing UTF-16 pagination", async () => {
    const store = new VariableStore();
    const original = "A\uD83C\uDF3FB";
    const stub = store.maybeCapture("source", original, true) as { variable: string };
    const tool = createInspectVariableTool(() => store);
    for (const [offset, expected] of [[0, "A\uFFFD"], [2, "\uFFFDB"], [1, "\uD83C\uDF3F"]] as const) {
      const output = await tool.execute!({ name: stub.variable, offset, maxChars: 2 }, options) as {
        content: string; offset: number; totalChars: number; nextOffset: number | null;
      };
      expect(output).toMatchObject({ offset, totalChars: 4, nextOffset: offset === 2 ? null : offset + 2 });
      expect(output.content).toBe(original.slice(offset, offset + 2));
      const modelOutput = tool.toModelOutput!({ output } as never) as { value: string };
      expect(modelOutput.value).toContain("\n" + expected);
      expect(modelOutput.value).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(store.get(stub.variable)).toBe(original);
  });
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
