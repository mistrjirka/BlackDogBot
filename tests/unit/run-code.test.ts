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
  const execute = (code: string) => tool.execute!({ code }, {} as ToolExecutionOptions<never>);
  return { store, stub, execute };
}

describe("run_code: separate data-only blackboard processing", () => {
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
