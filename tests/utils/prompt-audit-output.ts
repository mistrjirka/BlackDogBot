import { z } from "zod";

interface IRawEnvelope {
  overallGood?: boolean;
  results?: unknown;
}

interface IRawCategory {
  category?: unknown;
  good?: unknown;
  description?: unknown;
  issues?: unknown;
}

export function normalizePromptAuditEnvelope<TCategory extends z.ZodTypeAny>(
  parsed: unknown,
  expectedCategory: string,
  categorySchema: TCategory,
): {
  overallGood: boolean;
  results: Array<z.infer<TCategory>>;
} {
  const envelope: IRawEnvelope = (parsed ?? {}) as IRawEnvelope;
  const rawResults: unknown[] = Array.isArray(envelope.results) ? envelope.results : [];
  const candidates: IRawCategory[] = rawResults as IRawCategory[];

  const matched: IRawCategory[] = candidates.filter((item: IRawCategory): boolean => {
    return typeof item.category === "string" && item.category === expectedCategory;
  });

  const selected: IRawCategory = _pickBestResult(matched.length > 0 ? matched : candidates, expectedCategory);
  const normalizedCategory: unknown = {
    category: typeof selected.category === "string" ? selected.category : expectedCategory,
    good: typeof selected.good === "boolean" ? selected.good : false,
    description: typeof selected.description === "string"
      ? selected.description
      : `No explicit description returned for ${expectedCategory}.`,
    issues: Array.isArray(selected.issues) ? selected.issues : [],
  };

  return {
    overallGood: typeof envelope.overallGood === "boolean"
      ? envelope.overallGood
      : (normalizedCategory as { good: boolean }).good,
    results: [categorySchema.parse(normalizedCategory)],
  };
}

function _pickBestResult(candidates: IRawCategory[], expectedCategory: string): IRawCategory {
  if (candidates.length === 0) {
    return {
      category: expectedCategory,
      good: false,
      description: `No result returned for ${expectedCategory}.`,
      issues: [],
    };
  }

  return candidates.reduce((best: IRawCategory, current: IRawCategory): IRawCategory => {
    const bestHasDescription: boolean = typeof best.description === "string" && best.description.trim().length > 0;
    const currentHasDescription: boolean = typeof current.description === "string" && current.description.trim().length > 0;

    if (!bestHasDescription && currentHasDescription) {
      return current;
    }

    const bestIssuesCount: number = Array.isArray(best.issues) ? best.issues.length : -1;
    const currentIssuesCount: number = Array.isArray(current.issues) ? current.issues.length : -1;

    if (currentIssuesCount > bestIssuesCount) {
      return current;
    }

    return best;
  }, candidates[0]);
}
