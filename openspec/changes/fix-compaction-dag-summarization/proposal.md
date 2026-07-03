## Why

The compaction DAG fails to summarize large conversation histories because the summarization LLM call itself exceeds the hard gate (118,054 > 93,500 tokens). The catch block swallows the error and returns a placeholder, so the DAG thinks compaction succeeded when it didn't. Additionally, L3 and L4 use truncation and cropping instead of LLM summarization, which the user rejects. The fix repairs the DAG to be truncation-free: chunked multi-pass summarization for L1, per-message summarization for L3/L4, and proper error propagation instead of silent failures.

## What Changes

- **L1: Chunked multi-pass prefix summarization** — Replace single-shot summarization with chunked approach. Split prefix into ~30k token chunks, summarize each, combine results. No truncation.
- **L3: Per-message summarization** — Replace `_truncateToolResultsAsync` (hard truncation) with `_compactIndividualMessagesAsync` (LLM-based per-message summarization).
- **L4: Aggressive per-message summarization** — Replace `_cropMessagesFallbackAsync` (message dropping + cropping) with aggressive per-message summarization (shorter summaries).
- **DAG-level error handling** — Add try/catch around node execution. Errors propagate, DAG handles them gracefully.
- **Remove silent catch block** — `_summarizeTextAsync` no longer swallows errors. Errors propagate to DAG.
- **Consolidate `HARD_GATE_THRESHOLD_PERCENTAGE`** — Move from `base-agent.ts` to `src/shared/constants.ts` to eliminate duplication.

## Capabilities

### New Capabilities
- `truncation-free-compaction`: All compaction is LLM-based summarization. No truncation, no cropping. Chunked multi-pass for large prefixes. Per-message summarization for individual large messages.

### Modified Capabilities
<!-- None - no existing specs in the repo -->

## Impact

- **Files affected**:
  - `src/utils/summarization-compaction.ts` — primary changes (L1 chunking, L3/L4 replacement, error handling)
  - `src/shared/constants.ts` — new constant
  - `src/agent/base-agent.ts` — import update
  - `src/services/ai-provider.service.ts` — import update
  - `src/services/cron-message-history.service.ts` — add contextWindow
  - `tests/unit/context-overflow.test.ts` — import update
- **No API changes**: Internal compaction behavior only.
- **No dependency changes**: Uses existing tiktoken-based counting.
- **Behavioral change**: Compaction is now truncation-free. Latency increases (more LLM calls) but quality improves (no content loss).
