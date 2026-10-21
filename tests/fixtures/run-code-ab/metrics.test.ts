/**
 * Phase 2 A/B harness — unit tests for metrics.ts pure functions (plan §1.2).
 * No model, no filesystem: all inputs are synthetic.
 */

import { describe, it, expect } from "vitest";

import {
  collectWireCalls,
  destructiveDiff,
  firstDivergence,
  isSyntaxErrorText,
  jaccard5,
  classifyResolverValue,
  parseTraceLine,
  relayOfCall,
  relayReport,
  resolverReport,
  rowsEqual,
  tokenTotals,
  usageOfRecord,
  type ITraceRecordLike,
} from "./metrics.js";

//#region helpers

function wireBody(calls: { id: string; name: string; args: string }[], priors: string[]): unknown {
  const messages: unknown[] = [];
  for (const p of priors) {
    messages.push({ role: "tool", tool_call_id: `call-prior`, content: p });
  }
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args },
    })),
  });
  return { messages };
}

//#endregion helpers

describe("parseTraceLine / usageOfRecord", () => {
  it("returns null on blank/unparseable lines", () => {
    expect(parseTraceLine("")).toBeNull();
    expect(parseTraceLine("   \n")).toBeNull();
    expect(parseTraceLine("{not json")).toBeNull();
  });

  it("prefers the post-patch usage field", () => {
    const rec = parseTraceLine(
      JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 }, response: "{}", responseTruncated: false }),
    );
    expect(rec).not.toBeNull();
    expect(usageOfRecord(rec!)).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("falls back to parsing the response body (pre-patch records)", () => {
    const rec: ITraceRecordLike = {
      response: JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
      responseTruncated: false,
    };
    expect(usageOfRecord(rec)).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it("returns null when the response is truncated and unparseable", () => {
    const rec: ITraceRecordLike = { response: '{"choices":[{tru', responseTruncated: true };
    expect(usageOfRecord(rec)).toBeNull();
  });
});

describe("tokenTotals", () => {
  it("sums usage and flags missing records", () => {
    const records: ITraceRecordLike[] = [
      { usage: { prompt_tokens: 100, completion_tokens: 20 }, requestBody: { messages: [] } },
      { usage: { prompt_tokens: 50, completion_tokens: 10 }, requestBody: { messages: [] } },
      { response: "garbage{", responseTruncated: true },
    ];
    const t = tokenTotals(records);
    expect(t.in).toBe(150);
    expect(t.out).toBe(30);
    expect(t.total).toBe(180);
    expect(t.records).toBe(3);
    expect(t.missingUsage).toBe(1);
  });
});

describe("jaccard5", () => {
  it("is 1 for identical strings", () => {
    expect(jaccard5("hello world", "hello world")).toBe(1);
  });

  it("is 0 for disjoint strings; empty inputs follow the G5 formula", () => {
    expect(jaccard5("aaaaa", "bbbbb")).toBe(0);
    // G5("") = {""} per plan §4.3, so J5("","") = 1/1 = 1 (empty-union guard is unreachable).
    expect(jaccard5("", "")).toBe(1);
  });

  it("is high for near-contained strings (arm-A re-emission shape)", () => {
    const blob: string = "x".repeat(100) + "PAYLOAD-marker-payload-data-here" + "y".repeat(100);
    const args: string = `[{"note":"read ok","rows":[${blob}]}]`;
    expect(jaccard5(args, blob)).toBeGreaterThan(0.5);
  });
});

describe("collectWireCalls first-body-wins", () => {
  it("keeps the first body for a repeated call id (compaction-safe)", () => {
    const first: ITraceRecordLike = {
      requestBody: wireBody([{ id: "call-1", name: "write_table_news", args: '{"data":[1]}' }], ["prior-result"]),
    };
    const second: ITraceRecordLike = {
      // post-compaction body: same id, different (compacted) context
      requestBody: wireBody([{ id: "call-1", name: "write_table_news", args: '{"data":[1]}' }], ["compacted"]),
    };
    const { calls, priors } = collectWireCalls([first, second]);
    expect(calls).toHaveLength(1);
    expect(priors[0]).toEqual(["prior-result"]);
  });

  it("prior(C) only includes tool messages BEFORE the call (ordering)", () => {
    const body = {
      messages: [
        { role: "tool", tool_call_id: "a", content: "before-result" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-9", type: "function", function: { name: "w", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "b", content: "after-result" },
      ],
    };
    const { priors } = collectWireCalls([{ requestBody: body }]);
    expect(priors[0]).toEqual(["before-result"]);
  });
});

describe("relayOfCall / relayReport", () => {
  it("is 0 with empty prior", () => {
    expect(relayOfCall('{"data":[1,2,3]}', [])).toEqual({ chars: 0, jaccard: 0 });
  });

  it("a ~58-char ref scores far below a ~4KB re-emission (plan §4.3 anchors)", () => {
    const blob: string = "z".repeat(500) + fillerish(3600) + "z".repeat(500);
    const reemit: string = JSON.stringify([{ data: blob }]);
    const ref: string = JSON.stringify({ type: "variable", name: "v1" });
    const rReemit = relayOfCall(reemit, [blob]);
    const rRef = relayOfCall(ref, [`note stored rows under variable v1 count 15`]);
    expect(rReemit.chars).toBeGreaterThan(2000);
    expect(rRef.chars).toBeLessThan(1500);
  });

  it("p90 uses nearest-rank ceil(0.9n)-1", () => {
    const records: ITraceRecordLike[] = [];
    for (let i: number = 1; i <= 10; i++) {
      const args: string = "a".repeat(i * 10);
      records.push({
        requestBody: wireBody([{ id: `c${i}`, name: "t", args }], ["a".repeat(i * 10)]),
      });
    }
    const r = relayReport(records);
    expect(r.callCount).toBe(10);
    // identical args/prior → jaccard 1 → chars = length; p90 of 10..100 = 90
    expect(r.p90Chars).toBe(90);
    expect(r.meanChars).toBe(55);
    expect(r.top3.map((t) => t.chars)).toEqual([100, 90, 80]);
  });
});

function fillerish(n: number): string {
  return "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n);
}

describe("resolver branches", () => {
  it("classifies rule-1 ref-object, rule-2 stringified, literal array, other", () => {
    expect(classifyResolverValue({ type: "variable", name: "v1" })).toBe("rule1");
    expect(classifyResolverValue(JSON.stringify({ type: "variable", name: "v1" }))).toBe("rule2");
    expect(classifyResolverValue([{ id: 1 }])).toBe("literal");
    expect(classifyResolverValue("plain text")).toBe("other");
    expect(classifyResolverValue({ type: "variable" })).toBe("other"); // not strict 2-key
    expect(classifyResolverValue({ type: "variable", name: "v", extra: 1 })).toBe("other");
  });

  it("resolverReport counts branches and unknown_variable payloads", () => {
    const records: ITraceRecordLike[] = [
      { requestBody: wireBody([{ id: "c1", name: "write_table_news", args: JSON.stringify({ data: { type: "variable", name: "v1" } }) }], []) },
      { requestBody: wireBody([{ id: "c2", name: "write_table_news", args: JSON.stringify({ data: [{ id: 1 }] }) }], []) },
      {
        requestBody: {
          messages: [
            { role: "tool", tool_call_id: "c9", content: JSON.stringify({ ok: false, error: "unknown_variable", name: "v9" }) },
          ],
        },
      },
    ];
    const r = resolverReport(records);
    expect(r.rule1).toBe(1);
    expect(r.literal).toBe(1);
    expect(r.unknown).toHaveLength(1);
  });
});

describe("isSyntaxErrorText", () => {
  it("matches validation shapes but excludes unknown_variable", () => {
    expect(isSyntaxErrorText('Expected array, received object at "data"')).toBe(true);
    expect(isSyntaxErrorText('{"ok":false,"error":"unknown_variable"}')).toBe(false);
    expect(isSyntaxErrorText("all rows copied")).toBe(false);
  });
});

describe("destructiveDiff", () => {
  const before = {
    rss_inbox: [{ id: 1 }],
    news: [],
  };

  it("is clean when only the allowed table changed", () => {
    const d = destructiveDiff(before, { rss_inbox: [{ id: 1 }], news: [{ id: 1 }] }, ["news"]);
    expect(d.destructive).toBe(false);
  });

  it("flags source-table mutation, added tables, and dropped tables", () => {
    expect(destructiveDiff(before, { rss_inbox: [], news: [] }, ["news"]).destructive).toBe(true);
    const added = destructiveDiff(before, { ...before, evil: [] }, ["news"]);
    expect(added.destructive).toBe(true);
    expect(added.addedTables).toEqual(["evil"]);
    const dropped = destructiveDiff(before, { rss_inbox: [{ id: 1 }] }, ["news"]);
    expect(dropped.destructive).toBe(true);
    expect(dropped.droppedTables).toEqual(["news"]);
  });

  it("is order-insensitive for unchanged multisets", () => {
    const d = destructiveDiff(
      { t: [{ id: 2 }, { id: 1 }] },
      { t: [{ id: 1 }, { id: 2 }] },
      [],
    );
    expect(d.destructive).toBe(false);
  });
});

describe("rowsEqual / firstDivergence", () => {
  it("is order-normalized by id", () => {
    expect(rowsEqual([{ id: 2 }, { id: 1 }], [{ id: 1 }, { id: 2 }])).toBe(true);
    expect(rowsEqual([{ id: 1, v: "a" }], [{ id: 1, v: "b" }])).toBe(false);
    expect(rowsEqual([{ id: 1 }], [{ id: 1 }, { id: 2 }])).toBe(false);
  });

  it("describes count vs content divergence", () => {
    expect(firstDivergence([{ id: 1 }], [{ id: 1 }, { id: 2 }])).toMatch(/row count differs/);
    expect(firstDivergence([{ id: 1, v: "x" }], [{ id: 1, v: "y" }])).toMatch(/row id:1 differs/);
  });
});
