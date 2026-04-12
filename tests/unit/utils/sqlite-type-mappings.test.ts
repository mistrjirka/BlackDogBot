import { describe, expect, it } from "vitest";

import { isDateLikeColumn } from "../../../src/utils/sqlite-type-mappings.js";

describe("isDateLikeColumn", () => {
  it("returns true for common timestamp column names", () => {
    expect(isDateLikeColumn({ name: "updated_at", type: "TEXT" })).toBe(true);
  });

  it("returns true for date-like SQL column types", () => {
    expect(isDateLikeColumn({ name: "logged_when", type: "DATETIME" })).toBe(true);
  });

  it("returns true for parametrized date-like SQL types", () => {
    expect(isDateLikeColumn({ name: "logged_when", type: "TIMESTAMP(6)" })).toBe(true);
  });

  it("returns false for non-date columns", () => {
    expect(isDateLikeColumn({ name: "title", type: "TEXT" })).toBe(false);
  });
});
