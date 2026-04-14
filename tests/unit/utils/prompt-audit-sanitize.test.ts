import { describe, expect, it } from "vitest";

function normalizePattern(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPotentiallySpeculativeIssue(issue: { title: string; detail: string }): boolean {
  const normalizedTitle: string = normalizePattern(issue.title);
  const normalizedDetail: string = normalizePattern(issue.detail);

  const speculativeIndicators: string[] = [
    "impossible",
    "cannot",
    "critical",
    "best practice",
    "comprehensive",
    "lacks",
    "missing safety warning",
    "should warn",
    "would improve",
    "could improve",
  ];

  return speculativeIndicators.some((indicator: string): boolean => {
    return normalizedTitle.includes(indicator) || normalizedDetail.includes(indicator);
  });
}

describe("prompt audit sanitize helpers", () => {
  it("flags speculative best-practice language", () => {
    expect(
      isPotentiallySpeculativeIssue({
        title: "Missing explicit warning about permanent data modification",
        detail: "Consistency in safety warnings would improve clarity.",
      }),
    ).toBe(true);
  });

  it("keeps grounded ambiguity issue language", () => {
    expect(
      isPotentiallySpeculativeIssue({
        title: "Ambiguous parameter semantics",
        detail: "Description does not state if threshold uses 0-1 scale.",
      }),
    ).toBe(false);
  });
});
