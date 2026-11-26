import { describe, expect, it } from "vitest";
import { toWellFormedText } from "../../../src/utils/unicode.js";

describe("toWellFormedText", () => {
  it.each(["", "plain text", "e\u0301", "\uD83C\uDF3F", "\uD83D\uDC69\u200D\uD83D\uDCBB"])(
    "preserves valid text %j byte for byte",
    (text) => {
      expect(toWellFormedText(text)).toBe(text);
    },
  );

  it.each([
    ["\uD83C", "\uFFFD"],
    ["\uDF3F", "\uFFFD"],
    ["\uD83CA\uDF3F", "\uFFFDA\uFFFD"],
    ["\uD83C\uD83C\uDF3F\uDF3F", "\uFFFD\uD83C\uDF3F\uFFFD"],
    ["\\udf3f", "\\udf3f"],
  ])("repairs isolated surrogates in %j without changing UTF-16 length", (text, expected) => {
    const repaired = toWellFormedText(text);
    expect(repaired).toBe(expected);
    expect(repaired).toHaveLength(text.length);
    expect(repaired).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});
