import { describe, expect, it } from "vitest";
import { createRunCodeTool } from "../../src/tools/run-code.tool.js";
import { VariableStore, wrapToolSetWithVariables } from "../../src/utils/variable-store.js";
import type { ToolSet, ToolExecutionOptions } from "ai";

function createSetup() {
  const store = new VariableStore();
  const stub = store.maybeCapture("mcp.searxng.search", {
    results: Array.from({ length: 120 }, (_, i) => ({ title: `item-${i}`, score: i, "dc:creator": "user" })),
  }) as { variable: string };
  const tool = createRunCodeTool(() => store);
  const execute = (code: string, maxOutputChars?: number) =>
    tool.execute!({ code, ...(maxOutputChars === undefined ? {} : { maxOutputChars }) }, {} as ToolExecutionOptions<never>);
  return { store, stub, execute };
}

describe("run_code: separate data-only blackboard processing", () => {

  it("repairs a surrogate split by the display limit while preserving stored output and offsets", async () => {
    const { store, execute } = createSetup();
    const original = "a".repeat(2999) + "\uD83C\uDF3Ftail";
    const result = await execute('print("a".repeat(2999) + "\\uD83C\\uDF3Ftail")') as {
      display: string; fullOutputVariable: string; output: Record<string, number>;
      nextWith: { arguments: { offset: number } };
    };
    expect(result.display).toBe("a".repeat(2999) + "\uFFFD");
    expect(result.display).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result.output).toMatchObject({ producedChars: 3005, shownChars: 3000, omittedChars: 5 });
    expect(result.nextWith.arguments.offset).toBe(3000);
    expect(store.get(result.fullOutputVariable)).toBe(original);
  });
  it("filters structured MCP data, prints a preview and stores new data", async () => {
    const { store, stub, execute } = createSetup();
    expect(stub.variable).toMatch(/^mcp_searxng_search_\d+$/);
    const result = await execute(`const a = ${stub.variable}.filter(x => x.score > 115).map(x => ({title:x.title, creator:x.dc_creator})); print(a.length); return a;`) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, count: 4, display: "4" });
    expect(result.variable).toMatch(/^code_\d+$/);
    expect(store.get(result.variable as string)).toEqual([
      { title: "item-116", creator: "user" }, { title: "item-117", creator: "user" },
      { title: "item-118", creator: "user" }, { title: "item-119", creator: "user" },
    ]);
  });

  it("allows print-only inspection and does not create another variable", async () => {
    const { store, stub, execute } = createSetup();
    const before = store.names();
    const result = await execute(`console.log(${stub.variable}[0].title);`) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, display: "item-0" });
    expect(store.names()).toEqual(before);
  });

  it("prints every argument, including failed-search positions", async () => {
    const { execute } = createSetup();
    const result = await execute('const text = "FW <= 13.52"; print("div at:", text.indexOf("<div")); console.log("firmware at:", text.indexOf("FW"));') as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, display: "div at: -1\nfirmware at: 0" });
  });

  it("prints more than 1000 characters without per-print truncation", async () => {
    const { store, execute } = createSetup();
    const before = store.names();
    const result = await execute('print("a".repeat(1500))') as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true, display: "a".repeat(1500), truncated: false,
      output: { producedChars: 1500, shownChars: 1500, omittedChars: 0, bufferedChars: 1500, unbufferedChars: 0 },
    });
    expect(store.names()).toEqual(before);
  });

  it("caps the combined print stream by default and retains an exact continuation", async () => {
    const { store, execute } = createSetup();
    const full = "a".repeat(1900) + "\n" + "b".repeat(1600);
    const result = await execute('print("a".repeat(1900)); print("b".repeat(1600));') as {
      display: string; truncated: boolean; fullOutputVariable: string;
      output: Record<string, number>; nextWith: { tool: string; arguments: { name: string; offset: number; maxChars: number } };
    };
    expect(result.display).toBe(full.slice(0, 3000));
    expect(result.truncated).toBe(true);
    expect(result.output).toEqual({
      producedChars: 3501, shownChars: 3000, omittedChars: 501,
      bufferedChars: 3501, unbufferedChars: 0,
    });
    expect(store.get(result.fullOutputVariable)).toBe(full);
    expect(result.nextWith).toEqual({
      tool: "inspect_variable", arguments: { name: result.fullOutputVariable, offset: 3000, maxChars: 4000 },
    });
    expect(result.display + (store.get(result.fullOutputVariable) as string).slice(result.nextWith.arguments.offset)).toBe(full);
  });

  it("honors an optional output limit, preserving UTF-16 offset continuity", async () => {
    const { store, execute } = createSetup();
    const text = "😀".repeat(4000);
    const result = await execute('print("😀".repeat(4000))', 4500) as {
      display: string; fullOutputVariable: string; output: Record<string, number>;
    };
    expect(result.display).toBe(text.slice(0, 4500));
    expect(result.output).toMatchObject({ producedChars: 8000, shownChars: 4500, omittedChars: 3500 });
    expect(store.get(result.fullOutputVariable)).toBe(text);
  });

  it("stores only a bounded prefix if print exceeds 64000 characters and reports lost bytes", async () => {
    const { store, execute } = createSetup();
    const result = await execute('print("x".repeat(75000))') as {
      display: string; fullOutputVariable?: string; outputPrefixVariable: string;
      output: Record<string, number>; nextWith: { arguments: { offset: number } };
    };
    expect(result.display).toHaveLength(3000);
    expect(result.fullOutputVariable).toBeUndefined();
    expect(result.output).toEqual({ producedChars: 75000, shownChars: 3000,
      omittedChars: 72000, bufferedChars: 64000, unbufferedChars: 11000 });
    expect(store.get(result.outputPrefixVariable)).toBe("x".repeat(64000));
    expect(result.nextWith.arguments.offset).toBe(3000);
  });

  it("preserves an explicit larger display when wrapped by the automatic blackboard capture", async () => {
    const { store } = createSetup();
    const wrapped = wrapToolSetWithVariables({ run_code: createRunCodeTool(() => store) } as ToolSet, () => store);
    const result = await wrapped.run_code.execute!(
      { code: 'print("z".repeat(9500)); return { verified: true };', maxOutputChars: 7000 },
      {} as ToolExecutionOptions<never>,
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.display).toBe("z".repeat(7000));
    expect(result.output).toMatchObject({ producedChars: 9500, shownChars: 7000, omittedChars: 2500 });
    expect(store.get(result.fullOutputVariable as string)).toBe("z".repeat(9500));
    expect(store.get(result.variable as string)).toEqual({ verified: true });
    expect(store.names().filter(n => n.startsWith("run_code_"))).toHaveLength(0);
  });

  it("prints the full array rather than silently shortening it to three items", async () => {
    const { execute } = createSetup();
    const result = await execute('print([1, 2, 3, 4, 5]);') as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, display: "[1,2,3,4,5]", truncated: false });
  });

  it("returns structured syntax/identifier errors and rejects tool access", async () => {
    const { execute } = createSetup();
    const unknown = await execute("return mcp.searxng.search('bad');") as Record<string, unknown>;
    expect(unknown).toMatchObject({ ok: false, category: "unknown_variable" });
    expect(await execute("return 1 + ;")).toMatchObject({ ok: false, category: "syntax" });
    expect(await execute("return process.env; ")).toMatchObject({ ok: false, category: "unknown_variable" });
  });

  it("stores JSON null results without losing the variable", async () => {
    const { store, execute } = createSetup();
    const result = await execute("return null;") as { variable: string; type: string };
    expect(result.type).toBe("null");
    expect(store.names()).toContain(result.variable);
    expect(store.get(result.variable)).toBeNull();
  });

  it("does not allow constructor escape or filesystem access", async () => {
    const { execute } = createSetup();
    expect(await execute("return Object.constructor('return process')();")).toMatchObject({ ok: false, category: "validation" });
    expect(await execute("return require('node:fs');")).toMatchObject({ ok: false, category: "unknown_variable" });
  });

  it("transfers a returned variable directly into a compatible downstream tool", async () => {
    const { store, stub, execute } = createSetup();
    const result = await execute(`return ${stub.variable}.slice(0, 2).map(x => ({title:x.title}));`) as { variable: string };
    const sink = wrapToolSetWithVariables({ sink: {
      inputSchema: {}, execute: async (arg: unknown) => arg,
    } } as unknown as ToolSet, () => store);
    const saved = await sink.sink.execute!({ data: { type: "variable", name: result.variable } }, {} as ToolExecutionOptions<never>);
    expect(saved).toEqual({ data: [{ title: "item-0" }, { title: "item-1" }] });
  });
});
