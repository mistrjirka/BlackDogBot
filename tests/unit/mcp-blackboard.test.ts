import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import { z } from "zod";
import { convertMcpResultToModelOutput } from "../../src/services/mcp.service.js";
import { VariableStore, wrapToolSetWithVariables, MAX_VARIABLE_BYTES } from "../../src/utils/variable-store.js";

function wrapMcp(text: string, withImage = false) {
  const store = new VariableStore();
  const original = {
    inputSchema: z.object({}),
    execute: async () => ({ content: [{ type: "text", text }] }),
    toModelOutput: () => ({ type: "content" as const, value: [
      { type: "text", text },
      ...(withImage ? [{ type: "file", data: { type: "data", data: "ZmFrZQ==" }, mediaType: "image/png" }] : []),
    ] }),
  };
  const tool = wrapToolSetWithVariables({ "mcp.searxng.searxng_web_search": original } as unknown as ToolSet, () => store)["mcp.searxng.searxng_web_search"];
  const convert = () => tool.toModelOutput!({ output: { content: [{ type: "text", text }] } } as never) as { type: string; value: Array<{type: string; text?: string }> };
  return { store, convert };
}

describe("MCP results share the blackboard, without losing images", () => {
  it("stores JSON search results as structured data with a valid JS variable name", () => {
    const source = JSON.stringify({ results: Array.from({ length: 120 }, (_, i) => ({ title: `result ${i}`, url: `https://example.com/${i}` })) });
    const { store, convert } = wrapMcp(source);
    const output = convert();
    const stub = JSON.parse(output.value[0].text!);
    expect(stub.variable).toMatch(/^mcp_searxng_searxng_web_search_\d+$/);
    expect(stub.type).toBe("array");
    expect(store.get(stub.variable)).toHaveLength(120);
    expect(JSON.stringify(output).length).toBeLessThan(2700);
  });

  it("keeps image parts while shrinking large text", () => {
    const { store, convert } = wrapMcp("article text ".repeat(4000), true);
    const output = convert();
    expect(output.value.map(p => p.type)).toEqual(["text", "file"]);
    expect(JSON.parse(output.value[0].text!).variable).toBe(store.names()[0]);
  });

  it("preserves short MCP messages", () => {
    const { convert, store } = wrapMcp("small response");
    expect(convert().value[0].text).toBe("small response");
    expect(store.names()).toEqual([]);
  });

  it("stores multi-MiB results, but never inlines results exceeding memory limits", () => {
    const medium = wrapMcp("x".repeat(2 * 1024 * 1024));
    const stub = JSON.parse(medium.convert().value[0].text!);
    expect(medium.store.get(stub.variable)).toHaveLength(2 * 1024 * 1024);
    const huge = wrapMcp("x".repeat(MAX_VARIABLE_BYTES + 1));
    const output = huge.convert();
    expect(JSON.parse(output.value[0].text!)).toMatchObject({ error: "result_too_large" });
    expect(JSON.stringify(output).length).toBeLessThan(2500);
  });
});


describe("MCP structuredContent deduplication", () => {
  it("does not send the same JSON payload twice", () => {
    const data = { results: [{ title: "Title", url: "https://example.com" }] };
    const converted = convertMcpResultToModelOutput({
      content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com", title: "Title" }] }) }],
      structuredContent: data,
    }) as { type: string; value: Array<{type: string; text: string}> };
    expect(converted.value).toHaveLength(1);
    expect(JSON.parse(converted.value[0].text)).toEqual(data);
  });

  it("keeps unique supplementary structured content", () => {
    const converted = convertMcpResultToModelOutput({
      content: [{ type: "text", text: "Human-readable warning" }],
      structuredContent: { result: 5 },
    }) as { value: unknown[] };
    expect(converted.value).toHaveLength(2);
  });
});
