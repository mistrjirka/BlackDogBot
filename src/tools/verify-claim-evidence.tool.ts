import { tool } from "ai";
import { z } from "zod";
import type { VariableStore } from "../utils/variable-store.js";

const claimSchema = z.object({
  claim: z.string().min(5).max(450).describe("Concrete factual claim being checked; one assertion per item."),
  sourceVariable: z.string().min(1).max(155).describe("Name of saved actual source or derived excerpt, not a search-snippet variable."),
  exactQuote: z.string().min(12).max(1100).describe("Verbatim passage from the retrieved source. A matching quote is NOT proof of the conclusion."),
  claimedPlatform: z.enum(["PS4", "PS5", "other"]).optional().describe("Only when the claim concerns a specific console. Use other for unrelated topics."),
});

const inputSchema = z.object({ claims: z.array(claimSchema).min(1).max(5) });

/** Normalize layout and HTML markup for literal evidence lookup, not semantic scoring. */
function normalizeText(value: string): string {
  return value.replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|nbsp|lt|gt|quot);/gi, match => {
      const values: Record<string, string> = { "&amp;": "&", "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&quot;": '"' };
      return values[match.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ").trim();
}

/** Deterministic proof that a quote exists; never presents entailment as machine-verified. */
export function createVerifyClaimEvidenceTool(getStore: () => VariableStore | null) {
  return tool({
    description: "Check proposed research claims against exact passages in previously retrieved blackboard source content. Flags missing quotes and explicit PS4/PS5 mismatches; preserves the actual retrieved source URL. A FOUND quote does NOT prove the claim or its implications. Use for consequential/uncertain claims before answering; evaluate entailment yourself. Returns a saved evidence ledger variable.",
    inputSchema,
    execute: async ({ claims }: z.infer<typeof inputSchema>) => {
      const store = getStore();
      if (!store) return { ok: false, error: "no_active_blackboard" };
      const results = claims.map(({ claim, sourceVariable, exactQuote, claimedPlatform }) => {
        const source = store.get(sourceVariable);
        const sourceUrl = store.getSourceUrl(sourceVariable) ?? null;
        if (source === undefined) {
          return { claim, sourceVariable, sourceUrl, status: "missing_source_variable", quoteFound: false,
            note: "The source variable is unavailable/evicted; do not cite it as verified." };
        }
        const rawText = typeof source === "string" ? source : JSON.stringify(source);
        const haystack = normalizeText(rawText);
        const quote = normalizeText(exactQuote);
        const quoteFound = haystack.includes(quote);
        // Only an explicit opposite-platform name inside the actual quoted
        // passage is flagged; missing platform names do not prove a match.
        const scopeMismatch = quoteFound && (claimedPlatform === "PS4" && /\bPS5\b/i.test(quote) && !/\bPS4\b/i.test(quote)
          || claimedPlatform === "PS5" && /\bPS4\b/i.test(quote) && !/\bPS5\b/i.test(quote));
        const status = !quoteFound ? "quote_not_found" : scopeMismatch ? "scope_mismatch"
          : !sourceUrl ? "source_unattributed" : "passage_found";
        return { claim, sourceVariable, sourceUrl, status, quoteFound,
          quotedPassage: quoteFound ? quote.slice(0, 200) : undefined,
          note: !quoteFound ? "Quote not found in retained source; obtain and check the actual page."
            : scopeMismatch ? "Quoted evidence explicitly concerns the other console. It cannot prove this platform claim."
              : !sourceUrl ? "Exact quote exists but source URL is untracked. No semantic entailment or provenance verification."
                : "Exact passage exists in a URL-attributed source; this does not establish that the passage entails the claim.",
        };
      });
      const saved = store.maybeCapture("evidence", results, true);
      const ledgerVariable = saved && typeof saved === "object" && "variable" in saved
        ? (saved as { variable: string }).variable : null;
      return { ok: true, ledgerVariable, results,
        caution: "Quotation matching and simple platform checks ONLY; check logical entailment, dates, and contrary evidence manually." };
    },
  });
}
