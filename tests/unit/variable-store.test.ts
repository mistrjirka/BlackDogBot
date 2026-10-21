import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";

import {
  CAPTURE_THRESHOLD_CHARS,
  MAX_VARIABLE_BYTES,
  MAX_VARIABLES_PER_RUN,
  VARIABLE_REF_DESCRIPTION,
  VariableStore,
  variableRefSchema,
  wrapToolSetWithVariables,
} from "../../src/utils/variable-store.js";
import { wrapToolSetWithReasoning } from "../../src/utils/tool-reasoning-wrapper.js";
import { addKnowledgeToolInputSchema, writeFileToolInputSchema } from "../../src/shared/schemas/tool-schemas.js";
import { buildPerTableToolsAsync } from "../../src/utils/per-table-tools.js";
import * as litesql from "../../src/helpers/litesql.js";
import { resetSingletons } from "../utils/test-helpers.js";

vi.mock("../../src/helpers/litesql.js");

//#region Helpers

/** A stub shape, for ergonomic assertions. */
interface IStub {
  variable: string;
  type: "array" | "object" | "string" | "number" | "boolean";
  count?: number;
  sizeBytes: number;
  itemSchema?: unknown;
  preview?: unknown;
  meta?: Record<string, string | number | boolean | null>;
  note: string;
  total?: number;
}

function _asStub(value: unknown): IStub {
  return value as unknown as IStub;
}

/** A string whose JSON serialization is exactly `jsonChars` bytes (accounting for the surrounding quotes). */
function _stringWithJsonLength(jsonChars: number): string {
  return "a".repeat(Math.max(0, jsonChars - 2));
}

function _bigString(chars: number): string {
  return "x".repeat(chars);
}

function _makeRef(name: string): { type: "variable"; name: string } {
  return { type: "variable", name };
}

function _options(): ToolExecutionOptions<never> {
  return { toolCallId: "call_1", messages: [] } as unknown as ToolExecutionOptions<never>;
}

/**
 * A `content` field schema that accepts a literal string OR a variable reference.
 * The union is cast to `z.ZodType` so it satisfies ai-sdk's `Tool.inputSchema`
 * (whose `content` is resolved to a string by the wrapper before execute); the
 * runtime schema is still the real union for safeParse/JSON-schema purposes.
 */
function _capableContentSchema(): z.ZodType {
  return z.union([z.string(), variableRefSchema]) as unknown as z.ZodType;
}

//#endregion Helpers

describe("variable-store — constants", () => {
  it("exposes the documented thresholds", () => {
    expect(CAPTURE_THRESHOLD_CHARS).toBe(4000);
    expect(MAX_VARIABLES_PER_RUN).toBe(50);
    expect(MAX_VARIABLE_BYTES).toBe(1024 * 1024);
  });
});

describe("variableRefSchema", () => {
  it("accepts a well-formed reference and rejects garbage / extra keys", () => {
    expect(variableRefSchema.safeParse({ type: "variable", name: "x" }).success).toBe(true);
    expect(variableRefSchema.safeParse({ type: "variable" }).success).toBe(false);
    expect(variableRefSchema.safeParse({ type: "variable", name: "" }).success).toBe(false);
    expect(variableRefSchema.safeParse({ type: "variable", name: "x", extra: 1 }).success).toBe(false);
    expect(variableRefSchema.safeParse("stringified").success).toBe(false);
  });

  it("carries the spec §2.2 description", () => {
    expect(VARIABLE_REF_DESCRIPTION).toBe(
      "Stored blackboard reference. Use this exact object only in an input field whose schema advertises variable-reference support; it is not a shell environment variable. Pass the object as-is, never stringify it or use $NAME syntax.",
    );
  });
});

describe("VariableStore.maybeCapture — threshold (group 1)", () => {
  it("does not capture below the threshold and returns the original", () => {
    const store = new VariableStore();
    const value: string = _stringWithJsonLength(CAPTURE_THRESHOLD_CHARS - 1); // 3999-byte JSON

    const result = store.maybeCapture("t", value);

    expect(result).toBe(value);
    expect(store.names()).toEqual([]);
  });

  it("captures at/above the threshold, returns a stub, and stores the value", () => {
    const store = new VariableStore();
    const value: string = _stringWithJsonLength(CAPTURE_THRESHOLD_CHARS); // 4000-byte JSON

    const result = store.maybeCapture("t", value);

    const stub = _asStub(result);
    expect(stub.variable).toBe("t_1");
    expect(stub.type).toBe("string");
    expect(stub.sizeBytes).toBe(CAPTURE_THRESHOLD_CHARS);
    // Stored value deep-equals what was passed in.
    expect(store.get("t_1")).toEqual(value);
  });
});

describe("VariableStore.maybeCapture — naming (group 2)", () => {
  it("assigns run-global names of the form <toolName>_<n>", () => {
    const store = new VariableStore();
    store.maybeCapture("tool_a", _bigString(4500));
    store.maybeCapture("tool_b", _bigString(4500));

    expect(store.names()).toEqual(["tool_a_1", "tool_b_2"]);
  });
});

describe("VariableStore.maybeCapture — stub fields + total passthrough (group 3)", () => {
  it("emits variable/type/count/sizeBytes/preview/note for an array", () => {
    const store = new VariableStore();
    // The first two items are small (so the preview stays an array, <= 1200 chars);
    // the third item is large so the whole value clears the capture threshold.
    const value: Array<Record<string, unknown>> = [
      { title: "h0", link: "https://example.com/0" },
      { title: "h1", link: "https://example.com/1" },
      { title: "h2", note: "n".repeat(4200) },
    ];

    const stub = _asStub(store.maybeCapture("feed_rss", value));

    expect(stub.variable).toBe("feed_rss_1");
    expect(stub.type).toBe("array");
    expect(stub.count).toBe(3);
    expect(typeof stub.sizeBytes).toBe("number");
    expect(typeof stub.preview).toBe("object");
    expect((stub.preview as unknown[]).length).toBeGreaterThan(0);
    expect(stub.note).toContain('{"type":"variable","name":"feed_rss_1"}');
    expect(stub.note).toContain("not a shell variable");
    expect(stub.note).toContain("run_cmd cannot read it");
  });

  it("passes totalCount through", () => {
    const store = new VariableStore();
    const stub = _asStub(store.maybeCapture("q", { totalCount: 42, items: "i".repeat(4500) }));
    expect(stub.total).toBe(42);
  });

  it("passes total and matchingTotal through", () => {
    expect(_asStub(new VariableStore().maybeCapture("q", { total: 7, items: "i".repeat(4500) })).total).toBe(7);
    expect(_asStub(new VariableStore().maybeCapture("q", { matchingTotal: 9, items: "i".repeat(4500) })).total).toBe(9);
  });

  it("omits total when no numeric counter key is present", () => {
    const stub = _asStub(new VariableStore().maybeCapture("q", { items: "i".repeat(4500) }));
    expect(stub.total).toBeUndefined();
  });

  it("ignores a non-numeric counter value", () => {
    const stub = _asStub(new VariableStore().maybeCapture("q", { totalCount: "many", items: "i".repeat(4500) }));
    expect(stub.total).toBeUndefined();
  });
});

describe("VariableStore.maybeCapture — itemSchema (group 4)", () => {
it("recurses through nested objects until atomic leaves", () => {
const value = { name: "a", meta: { age: 5, active: true }, pad: "i".repeat(4200), pad2: "j".repeat(4200) };
const itemSchema = _asStub(new VariableStore().maybeCapture("v", value)).itemSchema as {
type: string;
properties: Record<string, unknown>;
};
expect(itemSchema.type).toBe("object");
expect(itemSchema.properties.name).toBe("string");
const meta = itemSchema.properties.meta as { type: string; properties: Record<string, unknown> };
expect(meta.type).toBe("object");
expect(meta.properties.age).toBe("number");
expect(meta.properties.active).toBe("boolean");
});

  it("suffixes '?' for a key present in only some sampled items", () => {
    const value = [
      { title: "a", link: "l1", media_content: "m1", pad: "i".repeat(1500) },
      { title: "b", link: "l2", pad: "i".repeat(1500) },
      { title: "c", link: "l3", media_content: "m3", pad: "i".repeat(1500) },
    ];
    // Array variables wrap their itemSchema as {type:"array", items:<item schema>}.
    const stub = _asStub(new VariableStore().maybeCapture("v", value));
    const items = stub.itemSchema as { type: string; items: { type: string; properties: Record<string, string> } };
    expect(stub.type).toBe("array");
    expect(items.type).toBe("array");
    expect(items.items.type).toBe("object");
    expect(items.items.properties.title).toBe("string");
    expect(items.items.properties.link).toBe("string");
    expect(items.items.properties.media_content).toBe("string?");
  });

  it("collapses objects deeper than ITEM_SCHEMA_MAX_DEPTH to 'object'", () => {
    // Two string fields so FIX-1 extraction does not fire (it needs exactly one).
    const value = { a: { b: { c: { d: "deep" } } }, pad: "i".repeat(4200), pad2: "j".repeat(4200) };
    const schema = _asStub(new VariableStore().maybeCapture("v", value));
    const c = (schema.itemSchema as { properties: { a: { properties: { b: { properties: Record<string, unknown> } } } } })
      .properties.a.properties.b.properties.c;
    expect(c).toBe("object");
  });

  it("builds an array-of-objects union schema", () => {
    const value = [
      { title: "a", views: 10, pad: "i".repeat(2200) },
      { title: "b", views: 20, pad: "i".repeat(2200) },
    ];
    const stub = _asStub(new VariableStore().maybeCapture("v", value));
    expect(stub.type).toBe("array");
    const items = stub.itemSchema as { type: string; items: { type: string; properties: Record<string, string> } };
    expect(items.type).toBe("array");
    expect(items.items.type).toBe("object");
    expect(items.items.properties.title).toBe("string");
    expect(items.items.properties.views).toBe("number");
  });

  it("treats a scalar variable as type:string with no itemSchema and a bounded preview", () => {
    const store = new VariableStore();
    const stub = _asStub(store.maybeCapture("v", _bigString(4500)));
    expect(stub.type).toBe("string");
    expect(stub.itemSchema).toBeUndefined();
    expect(typeof stub.preview).toBe("string");
    expect((stub.preview as string).length).toBeLessThanOrEqual(1200 + 4); // JSON.stringify adds quotes/ellipsis
  });
});

describe("VariableStore.maybeCapture — key normalization (group 5)", () => {
  it("normalizes keys at every depth consistently", () => {
    const store = new VariableStore();
    const value = {
      "media:content": "url1",
      "0abc": "digit",
      class: "kw",
      "a-b": "dash",
      "a.b": "dot",
      nested: { "dc:creator": "me" },
      pad: "i".repeat(4200),
      pad2: "j".repeat(4200),
    };

    const stub = _asStub(store.maybeCapture("v", value));
    const stored = store.get("v_1") as Record<string, unknown>;
    const props = (stub.itemSchema as { properties: Record<string, unknown> }).properties;

    // Sanitize: ':' -> '_'
    expect(stored).toHaveProperty("media_content");
    // Digit-leading -> '_' prefix
    expect(stored).toHaveProperty("_0abc");
    // Reserved word -> '_' suffix
    expect(stored).toHaveProperty("class_");
    // Collision within one object: 'a-b' and 'a.b' both sanitize to 'a_b' -> second gets '_2'
    expect(stored).toHaveProperty("a_b");
    expect(stored).toHaveProperty("a_b_2");
    // Nested depth
    expect((stored.nested as Record<string, unknown>).dc_creator).toBe("me");

    // itemSchema keys match the stored (normalized) keys.
    expect(Object.keys(props).sort()).toEqual(
      ["a_b", "a_b_2", "class_", "media_content", "_0abc", "nested", "pad", "pad2"].sort(),
    );
    expect((props.nested as { properties: Record<string, unknown> }).properties.dc_creator).toBe("string");
  });
});

describe("VariableStore.resolveInput (group 6)", () => {
  let store: VariableStore;
  let name: string;

  beforeEach(() => {
    store = new VariableStore();
    store.maybeCapture("res", _bigString(4500));
    name = store.names()[0];
  });

  it("resolves a rule-1 object reference", () => {
    const resolved = store.resolveInput({ content: _makeRef(name) });
    expect(resolved.error).toBeUndefined();
    expect((resolved.input as { content: string }).content).toBe(_bigString(4500));
  });

  it("passes through a ref-shaped object that carries extra keys", () => {
    const ref = { type: "variable", name, extra: 1 };
    const resolved = store.resolveInput({ content: ref });
    expect(resolved.error).toBeUndefined();
    expect((resolved.input as { content: unknown }).content).toEqual(ref);
  });

  it("unwraps a rule-2 stringified reference", () => {
    const resolved = store.resolveInput({ content: JSON.stringify(_makeRef(name)) });
    expect(resolved.error).toBeUndefined();
    expect((resolved.input as { content: string }).content).toBe(_bigString(4500));
  });

  it("passes through a non-reference JSON string", () => {
    const literal = JSON.stringify([1, 2, 3]);
    const resolved = store.resolveInput({ content: literal });
    expect(resolved.error).toBeUndefined();
    expect((resolved.input as { content: string }).content).toBe(literal);
  });

  it("returns a structured unknown_variable error (not a throw) with available names", () => {
    const resolved = store.resolveInput({ content: _makeRef("does_not_exist") });
    expect(resolved.error).toBeDefined();
    expect(resolved.error).toMatchObject({ ok: false, error: "unknown_variable" });
    expect((resolved.error as { available: string[] }).available).toContain(name);
  });

  it("leaves a reasoning field untouched", () => {
    const resolved = store.resolveInput({ reasoning: "think first", content: "literal" });
    expect(resolved.error).toBeUndefined();
    const input = resolved.input as { reasoning: string; content: string };
    expect(input.reasoning).toBe("think first");
    expect(input.content).toBe("literal");
  });

  it("leaves non-object input unchanged", () => {
    const resolved = store.resolveInput("just a string");
    expect(resolved.input).toBe("just a string");
    expect(resolved.error).toBeUndefined();
  });
});

describe("VariableStore — eviction (group 7)", () => {
  it("evicts FIFO to keep at most MAX_VARIABLES_PER_RUN", () => {
    const store = new VariableStore();
    for (let i: number = 0; i < MAX_VARIABLES_PER_RUN + 1; i++) {
      store.maybeCapture("a", _bigString(4500));
    }
    const names = store.names();
    expect(names).toHaveLength(MAX_VARIABLES_PER_RUN);
    expect(names).not.toContain("a_1"); // oldest evicted
    expect(names).toContain(`a_${MAX_VARIABLES_PER_RUN + 1}`); // newest kept
  });

  it("evicts when total bytes exceed MAX_TOTAL_BYTES", () => {
    const store = new VariableStore();
    // Each variable ~900 KB (< MAX_VARIABLE_BYTES); 10 of them exceed 8 MB.
    for (let i: number = 0; i < 10; i++) {
      store.maybeCapture("v", "a".repeat(900_000));
    }
    const names = store.names();
    expect(names.length).toBeLessThan(10);
    expect(names).not.toContain("v_1"); // oldest evicted first
    expect(names).toContain("v_10"); // newest kept
  });
});

describe("VariableStore.maybeCapture — edge cases (group 8)", () => {
  it("returns the original for a circular (non-serializable) value without throwing", () => {
    const store = new VariableStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = store.maybeCapture("circ", circular);

    expect(result).toBe(circular);
    expect(store.names()).toEqual([]);
  });

  it("does not capture null or undefined", () => {
    const store = new VariableStore();
    expect(store.maybeCapture("n", null)).toBeNull();
    expect(store.maybeCapture("u", undefined)).toBeUndefined();
    expect(store.names()).toEqual([]);
  });

  it("returns a >1MB result inline (never truncated) and does not store it", () => {
    const store = new VariableStore();
    const value: string = "a".repeat(MAX_VARIABLE_BYTES + 1);

    const result = store.maybeCapture("big", value);

    expect(result).toBe(value);
    expect(store.names()).toEqual([]);
  });
});

describe("wrapToolSetWithVariables — end to end (group 9)", () => {
  it("resolves a ref in args and stubs a large result", async () => {
    const store = new VariableStore();
    store.maybeCapture("payload", _bigString(4500));
    const refName = store.names()[0];

    let receivedInput: unknown = "unset";

    const fakeTool = {
      inputSchema: z.object({ content: z.union([z.string(), variableRefSchema]) }),
      execute: async (input: { content: unknown }): Promise<unknown> => {
        receivedInput = input;
        return `RESULT_${"z".repeat(4500)}`;
      },
    };

    const wrapped = wrapToolSetWithVariables({ echo: fakeTool }, () => store);
    const result = await (wrapped.echo as { execute: (i: unknown, o: ToolExecutionOptions<never>) => Promise<unknown> })
      .execute({ content: _makeRef(refName) }, _options());

    // Ref resolved: the tool received the raw stored string.
    expect((receivedInput as { content: string }).content).toBe(_bigString(4500));
    // Result stubbed (>= threshold). The counter is run-global, so the payload was
    // captured first (payload_1) and this echo result second (echo_2).
    expect(_asStub(result).variable).toBe("echo_2");
  });

  it("returns an unknown_variable error object (not a throw) for an unknown ref", async () => {
    const store = new VariableStore();
    store.maybeCapture("payload", _bigString(4500));

    const fakeTool = {
      inputSchema: _capableContentSchema(),
      execute: async (): Promise<unknown> => "should not run",
    };

    const wrapped = wrapToolSetWithVariables({ echo: fakeTool } as ToolSet, () => store);
    const result = await (wrapped.echo as unknown as {
      execute: (i: unknown, o: ToolExecutionOptions<never>) => Promise<unknown>;
    }).execute({ content: _makeRef("nope") }, _options());

    expect(result).toMatchObject({ ok: false, error: "unknown_variable" });
  });

  it("does not stub results for a tool that defines toModelOutput, but still resolves refs", async () => {
    const store = new VariableStore();
    store.maybeCapture("payload", _bigString(4500));
    const refName = store.names()[0];

    const fakeTool = {
      inputSchema: _capableContentSchema(),
      toModelOutput: (): unknown => ({ type: "text", value: "model-ready" }),
      execute: async (input: { content: unknown }): Promise<string> => `raw:${(input as { content: string }).content}`,
    };

    const wrapped = wrapToolSetWithVariables({ echo: fakeTool } as ToolSet, () => store);
    const result = await (wrapped.echo as unknown as {
      execute: (i: unknown, o: ToolExecutionOptions<never>) => Promise<unknown>;
    }).execute({ content: _makeRef(refName) }, _options());

    expect(result).toBe(`raw:${_bigString(4500)}`); // resolved, but NOT stubbed
    // Only the payload ref source was captured; the echo result was not re-stubbed.
    expect(store.names()).toEqual(["payload_1"]);
  });

  it("passes through a tool without execute unchanged", () => {
    const passthrough = { inputSchema: z.object({}) };
    const wrapped = wrapToolSetWithVariables({ dead: passthrough }, () => new VariableStore());
    expect((wrapped.dead as { execute?: unknown }).execute).toBeUndefined();
  });

  it("composes OUTERMOST over the reasoning wrapper: reasoning stripped AND ref resolved", async () => {
    const store = new VariableStore();
    store.maybeCapture("payload", _bigString(4500));
    const refName = store.names()[0];

    let receivedInput: unknown = "unset";
    const baseTool = {
      inputSchema: _capableContentSchema(),
      execute: async (input: { content: unknown }): Promise<unknown> => {
        receivedInput = input;
        return "ok";
      },
    };

    const reasoned = wrapToolSetWithReasoning({ echo: baseTool });
    const wrapped = wrapToolSetWithVariables(reasoned, () => store);

    await (wrapped.echo as { execute: (i: unknown, o: ToolExecutionOptions<never>) => Promise<unknown> }).execute(
      { content: _makeRef(refName), reasoning: "internal monologue" },
      _options(),
    );

    const received = receivedInput as { content: string; reasoning?: unknown };
    expect(received.content).toBe(_bigString(4500)); // ref resolved
    expect(received).not.toHaveProperty("reasoning"); // reasoning stripped by inner wrapper
  });
});

describe("variable-capable schema unions (group 10)", () => {
  beforeEach(() => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("writeFileToolInputSchema accepts a literal and a ref, rejects garbage", () => {
    expect(writeFileToolInputSchema.safeParse({ filePath: "n.txt", content: "hello" }).success).toBe(true);
    expect(
      writeFileToolInputSchema.safeParse({ filePath: "n.txt", content: { type: "variable", name: "x" } }).success,
    ).toBe(true);
    expect(writeFileToolInputSchema.safeParse({ filePath: "n.txt", content: 123 }).success).toBe(false);
  });

  it("addKnowledgeToolInputSchema accepts a literal and a ref, rejects garbage", () => {
    expect(addKnowledgeToolInputSchema.safeParse({ knowledge: "text", collection: "default" }).success).toBe(true);
    expect(
      addKnowledgeToolInputSchema.safeParse({
        knowledge: { type: "variable", name: "x" },
        collection: "default",
      }).success,
    ).toBe(true);
    expect(addKnowledgeToolInputSchema.safeParse({ knowledge: 123, collection: "default" }).success).toBe(false);
  });

  it("per-table write_table_* inputSchema is variable-capable", async () => {
    vi.mocked(litesql.safeListTablesAsync).mockResolvedValue({ tables: ["payloads"], status: "ok" });
    vi.mocked(litesql.safeGetTableSchemaAsync).mockResolvedValue({
      schema: {
        name: "payloads",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true, notNull: true, defaultValue: null },
          { name: "body", type: "TEXT", primaryKey: false, notNull: false, defaultValue: null },
        ],
      },
      status: "ok",
    });

    const { tools } = await buildPerTableToolsAsync();
    const writeTool = tools.write_table_payloads as { inputSchema: z.ZodTypeAny };

    expect(writeTool.inputSchema.safeParse({ data: [{ body: "x" }] }).success).toBe(true);
    expect(writeTool.inputSchema.safeParse({ data: { type: "variable", name: "y" } }).success).toBe(true);
    expect(writeTool.inputSchema.safeParse({ data: 123 }).success).toBe(false);
  });
});

describe("VariableStore.maybeCapture — FIX-1 primary-payload extraction (group 11)", () => {
  /** A read_from_database-style wrapper: one dominant rows array + scalar extras. */
  function _readWrapper(): { wrapper: Record<string, unknown>; rows: Array<Record<string, unknown>> } {
    const rows: Array<Record<string, unknown>> = [];
    for (let i: number = 1; i <= 25; i++) {
      rows.push({ id: i, payload: `row-${String(i).padStart(3, "0")}-${"a".repeat(180)}` });
    }
    const wrapper: Record<string, unknown> = {
      tableName: "e2e_src",
      rows,
      matchingTotal: 25,
      returnedCount: 25,
      offset: 0,
      limit: 25,
      remainingCount: 0,
      nextOffset: null,
      continuationHint: "25 items read, 0 remaining within current constraints.",
    };
    return { wrapper, rows };
  }

  it("read-wrapper → stores the rows array; stub describes the payload, meta + total survive", () => {
    const store = new VariableStore();
    const { wrapper, rows } = _readWrapper();

    const stub = _asStub(store.maybeCapture("read_from_database", wrapper));

    expect(stub.variable).toBe("read_from_database_1");
    expect(stub.type).toBe("array");
    expect(stub.count).toBe(25);
    // Stored value IS the payload (a ref resolves to exactly what write_table consumes).
    expect(store.get("read_from_database_1")).toEqual(rows);
    // sizeBytes measured post-normalization on the payload.
    expect(stub.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(rows), "utf8"));
    // Wrapper extras preserved for the model; whole-result counter coexists.
    expect(stub.meta?.tableName).toBe("e2e_src");
    expect(stub.meta?.matchingTotal).toBe(25);
    expect(stub.total).toBe(25);
    expect(stub.note).toContain('"name":"read_from_database_1"');
  });

  it("file-wrapper → stores the text payload with scalar meta", () => {
    const store = new VariableStore();
    const content: string = "x".repeat(4500);

    const stub = _asStub(store.maybeCapture("run_cmd", { content, bytes: 1502 }));

    expect(stub.type).toBe("string");
    expect(store.get("run_cmd_1")).toBe(content);
    expect(stub.meta).toEqual({ bytes: 1502 });
    expect(stub.total).toBeUndefined();
  });

  it("two array fields → no extraction (whole object captured, no meta)", () => {
    const store = new VariableStore();
    const value = { a: ["x".repeat(2200)], b: ["y".repeat(2200)] };

    const stub = _asStub(store.maybeCapture("v", value));

    expect(stub.type).toBe("object");
    expect(stub.meta).toBeUndefined();
    expect(store.get("v_1")).toEqual(value);
  });

  it("array + string → array wins (payload is the rows array)", () => {
    const store = new VariableStore();
    const rows: Array<Record<string, unknown>> = [];
    for (let i: number = 1; i <= 10; i++) {
      rows.push({ id: i, payload: "p".repeat(500) });
    }
    const stub = _asStub(store.maybeCapture("v", { rows, note: "short", total: 5 }));

    expect(stub.type).toBe("array");
    expect(store.get("v_1")).toEqual(rows);
    expect(stub.meta).toEqual({ note: "short", total: 5 });
  });

  it("a small array field blocks the string rule (whole object captured)", () => {
    const store = new VariableStore();
    const value = { rows: [1, 2, 3], text: "z".repeat(4500) };

    const stub = _asStub(store.maybeCapture("v", value));

    expect(stub.type).toBe("object");
    expect(stub.meta).toBeUndefined();
    expect(store.get("v_1")).toEqual(value);
  });

  it("meta caps at 10 fields in original key order", () => {
    const store = new VariableStore();
    const rows: Array<Record<string, unknown>> = [{ id: 1, payload: "p".repeat(4500) }];
    const wrapper: Record<string, unknown> = { rows };
    for (let i: number = 1; i <= 10; i++) {
      wrapper[`f${i}`] = i;
    }

    const stub = _asStub(store.maybeCapture("v", wrapper));

    expect(Object.keys(stub.meta ?? {})).toEqual(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"]);
  });

  it("meta drops trailing fields while over 1000 serialized chars", () => {
    const store = new VariableStore();
    const rows: Array<Record<string, unknown>> = [{ id: 1, payload: "p".repeat(4500) }];
    const s1: string = "a".repeat(400);
    const stub = _asStub(store.maybeCapture("v", { rows, s1, s2: "b".repeat(100) }));

    // Long secondary strings are truncated so key diagnostics survive.
    expect(stub.meta?.s1).toContain("aaa");
    expect((stub.meta?.s1 as string).length).toBeLessThanOrEqual(301);
  });

  it("meta omitted when no scalar wrapper fields remain", () => {
    const store = new VariableStore();
    const rows: Array<Record<string, unknown>> = [{ id: 1, payload: "p".repeat(4500) }];
    const stub = _asStub(store.maybeCapture("v", { rows, info: { nested: true } }));

    expect(stub.meta).toBeUndefined();
    expect(stub.type).toBe("array");
  });

  it("no extraction → behavior identical to before (whole object, no meta)", () => {
    const store = new VariableStore();
    const value = { alpha: "a".repeat(2200), beta: "b".repeat(2200) };

    const stub = _asStub(store.maybeCapture("v", value));

    expect(stub.type).toBe("object");
    expect(stub.meta).toBeUndefined();
    expect(store.get("v_1")).toEqual(value);
    expect(JSON.stringify(store.get("v_1"))).toBe(JSON.stringify(value));
  });
});

describe("VariableStore — hardening (group 12)", () => {
  it("resolve AFTER eviction → unknown_variable listing the REMAINING names", () => {
    const store = new VariableStore();
    store.maybeCapture("v", _bigString(4500)); // v_1, oldest — will be evicted
    for (let i: number = 0; i < MAX_VARIABLES_PER_RUN; i++) {
      store.maybeCapture("v", _bigString(4500));
    }
    expect(store.names()).toHaveLength(MAX_VARIABLES_PER_RUN);
    expect(store.names()).not.toContain("v_1");

    const resolved = store.resolveInput({ content: _makeRef("v_1") });

    expect(resolved.error).toMatchObject({ ok: false, error: "unknown_variable" });
    const available: string[] = (resolved.error as { available: string[] }).available;
    expect(available).toHaveLength(MAX_VARIABLES_PER_RUN);
    expect(available).not.toContain("v_1");
    expect(available).toContain(`v_${MAX_VARIABLES_PER_RUN + 1}`);
  });

  it("__proto__ key survives normalization as an own property", () => {
    const store = new VariableStore();
    // JSON.parse (checked) so `__proto__` arrives as an own data property.
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(
        `{"__proto__":"${"p".repeat(2200)}","pad":"${"i".repeat(2200)}","extra":"e"}`,
      ) as Record<string, unknown>;
    } catch {
      throw new Error("test fixture JSON must parse");
    }

    const stub = _asStub(store.maybeCapture("v", raw));

    expect(stub.type).toBe("object"); // multiple strings → no extraction
    const stored = store.get("v_1") as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(stored, "__proto__")?.value).toBe("p".repeat(2200));
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
  });

  it("partial object-typed key → optional:true (never \"[object Object]?\")", () => {
    const store = new VariableStore();
    const value = [
      { id: 1, opts: { a: 1 }, pad: "x".repeat(2200) },
      { id: 2, pad: "y".repeat(2200) },
    ];

    const stub = _asStub(store.maybeCapture("v", value));
    const items = stub.itemSchema as { type: string; items: { type: string; properties: Record<string, unknown> } };

    expect(items.items.properties.opts).toEqual({ type: "object", properties: { a: "number" }, optional: true });
  });

  it("malformed refs pass through as literals (no error)", () => {
    const store = new VariableStore();
    store.maybeCapture("v", _bigString(4500));

    for (const malformed of [
      { type: "variable" }, // missing name
      { type: "variable", name: 123 }, // non-string name
      { type: "var", name: "v_1" }, // type !== variable
    ]) {
      const resolved = store.resolveInput({ content: malformed });
      expect(resolved.error).toBeUndefined();
      expect((resolved.input as { content: unknown }).content).toEqual(malformed);
    }
  });

  it("empty array → itemSchema omits items (no fabricated type)", () => {
    const store = new VariableStore();
    const stub = _asStub(
      store.maybeCapture("v", { items: [], pad1: "a".repeat(2200), pad2: "b".repeat(2200) }),
    );

    expect(stub.type).toBe("object");
    const props = (stub.itemSchema as { properties: Record<string, unknown> }).properties;
    expect(props.items).toEqual({ type: "array" });
  });

  it("null store + ref-shaped input → structured unknown_variable with available:[]", async () => {
    const fakeTool = {
      inputSchema: _capableContentSchema(),
      execute: async (): Promise<unknown> => "should not run",
    };
    const wrapped = wrapToolSetWithVariables({ echo: fakeTool } as ToolSet, () => null);
    const executor = wrapped.echo as unknown as {
      execute: (i: unknown, o: ToolExecutionOptions<never>) => Promise<unknown>;
    };

    const result = await executor.execute({ content: _makeRef("x") }, _options());
    expect(result).toMatchObject({ ok: false, error: "unknown_variable", available: [] });

    const stringified = await executor.execute({ content: JSON.stringify(_makeRef("x")) }, _options());
    expect(stringified).toMatchObject({ ok: false, error: "unknown_variable", available: [] });
  });

  it("null store + literal input → passes through to execute", async () => {
    const fakeTool = {
      inputSchema: _capableContentSchema(),
      execute: async (input: { content: unknown }): Promise<unknown> => `got:${input.content}`,
    };
    const wrapped = wrapToolSetWithVariables({ echo: fakeTool } as ToolSet, () => null);
    const result = await (wrapped.echo as unknown as {
      execute: (i: unknown, o: ToolExecutionOptions<never>) => Promise<unknown>;
    }).execute({ content: "plain literal" }, _options());

    expect(result).toBe("got:plain literal");
  });

describe("VariableStore — real run_cmd/read_file wrappers", () => {
  it("stores run_cmd stdout (not stderr) and preserves diagnostics in meta", () => {
    const store = new VariableStore();
    const stdout: string = "out ".repeat(1200);
    const stderr: string = "err ".repeat(50);
    const stub = _asStub(store.maybeCapture("run_cmd", {
      stdout,
      stderr,
      exitCode: 2,
      status: "failed",
      error: "boom",
      timedOut: false,
    }));

    expect(stub.type).toBe("string");
    expect(store.get("run_cmd_1")).toContain(stdout.slice(0, 100));
    expect(store.get("run_cmd_1")).toContain("[stderr]");
    expect(store.get("run_cmd_1")).toContain(stderr.trim());
    expect(stub.meta).toMatchObject({ exitCode: 2, status: "failed", error: "boom" });
    expect(stub.meta?.stderr).toContain("err");
  });

  it("stores read_file content without the wrapper object", () => {
    const store = new VariableStore();
    const content: string = "line\n".repeat(1200);
    const stub = _asStub(store.maybeCapture("read_file", {
      success: true,
      content,
      message: "File read successfully.",
    }));

    expect(stub.type).toBe("string");
    expect(store.get("read_file_1")).toBe(content);
    expect(stub.meta).toMatchObject({ success: true });
  });
});
});
