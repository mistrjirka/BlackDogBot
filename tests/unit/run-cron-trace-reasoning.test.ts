import { describe, expect, it } from "vitest";

import { summarizeJson } from "../../src/utils/json-summarize.js";

interface IToolCallTraceLike {
  step: number;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
}

function truncateTraceInput(trace: IToolCallTraceLike): Record<string, unknown> {
  const input = trace.input as Record<string, unknown>;

  if (trace.name === "send_message" && typeof input.message === "string") {
    const message = input.message;
    if (message.length > 200) {
      return {
        ...input,
        message: message.slice(0, 200) + "\n\n[TRUNCATED - full message shown in Messages section]",
      };
    }
  }

  return input;
}

function extractReasoningPreview(input: Record<string, unknown>): string | null {
  if (!("reasoning" in input)) {
    return null;
  }

  const reasoningValue: unknown = input.reasoning;

  if (typeof reasoningValue !== "string") {
    return null;
  }

  const trimmedReasoning: string = reasoningValue.trim();

  if (trimmedReasoning.length === 0) {
    return null;
  }

  if (trimmedReasoning.length <= 280) {
    return trimmedReasoning;
  }

  return trimmedReasoning.slice(0, 280) + "…";
}

function buildTraceMarkdown(traces: IToolCallTraceLike[]): string {
  const lines: string[] = [];
  lines.push("### Tool Call Trace");
  lines.push("");

  for (const trace of traces) {
    const truncatedInput = truncateTraceInput(trace);
    const reasoningPreview: string | null = extractReasoningPreview(truncatedInput);

    lines.push(`#### Step ${trace.step}: \`${trace.name}\``);
    lines.push("");
    if (reasoningPreview) {
      lines.push("**Reasoning:**");
      lines.push("");
      lines.push(reasoningPreview);
      lines.push("");
    }
    lines.push("**Input:**");
    lines.push("```json");
    lines.push(JSON.stringify(truncatedInput, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("**Output (shortened):**");
    lines.push("```json");
    lines.push(summarizeJson(trace.output));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

describe("run cron trace reasoning formatting", () => {
  it("shows reasoning section when provided in tool input", () => {
    const markdown: string = buildTraceMarkdown([
      {
        step: 3,
        name: "searxng",
        input: {
          query: "latest update",
          reasoning: "Need a fresh source before final answer.",
        },
        output: { results: [] },
        isError: false,
      },
    ]);

    expect(markdown).toContain("**Reasoning:**");
    expect(markdown).toContain("Need a fresh source before final answer.");
  });
});
