import { describe, expect, it } from "vitest";
import { z } from "zod";

import { normalizePromptAuditEnvelope } from "../../utils/prompt-audit-output.js";

const IssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  toolName: z.string(),
  title: z.string(),
  detail: z.string(),
  evidenceQuote: z.string(),
  fix: z.string(),
});

const CategorySchema = z.object({
  category: z.string(),
  good: z.boolean(),
  description: z.string(),
  issues: IssueSchema.array(),
});

describe("normalizePromptAuditEnvelope", () => {
  it("picks expected category when model returns duplicate results", () => {
    const parsed: unknown = {
      overallGood: true,
      results: [
        {
          category: "cron_scheduling_tools",
          good: true,
          issues: [],
        },
        {
          category: "cron_scheduling_tools",
          good: true,
          description: "clear and complete",
          issues: [],
        },
      ],
    };

    const normalized = normalizePromptAuditEnvelope(parsed, "cron_scheduling_tools", CategorySchema);

    expect(normalized.results).toHaveLength(1);
    expect(normalized.results[0].description).toBe("clear and complete");
  });

  it("fills missing description with fallback text", () => {
    const parsed: unknown = {
      overallGood: false,
      results: [
        {
          category: "database_tools",
          good: false,
          issues: [],
        },
      ],
    };

    const normalized = normalizePromptAuditEnvelope(parsed, "database_tools", CategorySchema);

    expect(normalized.results).toHaveLength(1);
    expect(normalized.results[0].description.length).toBeGreaterThan(0);
  });
});
