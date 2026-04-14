import { describe, expect, it } from "vitest";

import { parseJsonWithCommonRepairs } from "../../../src/utils/json-repair.js";

describe("parseJsonWithCommonRepairs", () => {
  it("parses valid json unchanged", () => {
    const parsed = parseJsonWithCommonRepairs('{"a":1,"b":[2,3]}') as { a: number; b: number[] };
    expect(parsed.a).toBe(1);
    expect(parsed.b).toEqual([2, 3]);
  });

  it("parses fenced json", () => {
    const parsed = parseJsonWithCommonRepairs('```json\n{"ok":true}\n```') as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("repairs trailing commas", () => {
    const parsed = parseJsonWithCommonRepairs('{"items":[{"x":1,},],}') as { items: Array<{ x: number }> };
    expect(parsed.items[0].x).toBe(1);
  });

  it("repairs missing closing brackets/braces", () => {
    const parsed = parseJsonWithCommonRepairs('{"items":[{"x":1}') as { items: Array<{ x: number }> };
    expect(parsed.items[0].x).toBe(1);
  });

  it("repairs single-quoted strings", () => {
    const parsed = parseJsonWithCommonRepairs("{'message':'hello'}") as { message: string };
    expect(parsed.message).toBe("hello");
  });

  it("repairs dangling quote after array/object close", () => {
    const parsed = parseJsonWithCommonRepairs('{"overallGood":true,"results":[{"category":"x","good":true,"description":"ok","issues":[]"}]}') as {
      overallGood: boolean;
      results: Array<{ category: string; good: boolean; description: string; issues: unknown[] }>;
    };
    expect(parsed.overallGood).toBe(true);
    expect(parsed.results[0].category).toBe("x");
  });

  it("throws when content is not recoverable json", () => {
    expect(() => parseJsonWithCommonRepairs("definitely not json")).toThrow(/unable to parse json/i);
  });
});
