## Context

The compaction DAG (`_compactViaDagAsync` in `summarization-compaction.ts`) processes conversation histories through a series of compaction nodes (L1-L7) to reduce token count below a target threshold. L1 performs multi-stage compaction (prefix, latest user, tool results). L2 compacts individual tool results. L3/L4 perform batched message summarization. L5-L7 are multimodal fallbacks.

**Current failure mode** (from production logs):
- Large uncompacted history (97k tokens actual) enters DAG
- L1 Stage A attempts single-shot summarization of entire prefix (exceeds 93.5k hard gate)
- **Chunking doesn't trigger** because `countTokens(unpinnedPrefixMessages)` ≤ 30k threshold
- Hard gate blocks request → L1 Stage A fails → L1 continues to Stage B/C
- L2 finds no tool results → returns unchanged → DAG routes L1→L2→L4 (skips L3)
- L4 aggressive batched eventually works but after many failed calls
- Total compaction takes 40+ seconds with multiple hard gate rejections

**Root cause:** `countTokens()` counts structured message tokens (JSON format), but the actual LLM request body uses plain text with verbose labels (`[User]:`, `[Assistant]:`, `[Tool call]:`, `[Tool result]:`) plus JSON serialization overhead. This inflates actual token count by **3.2x** in the observed case (97k actual vs ~30k counted). The chunking decision uses the wrong metric.

## Goals / Non-Goals

**Goals:**
1. L1 chunked summarization reliably triggers for large prefixes and stays under hard gate
2. DAG attempts L3 batched summarization after L2 even when L2 doesn't improve
3. No regression on existing compaction behavior for normal-sized conversations

**Non-Goals:**
- Changing the hard gate threshold (85% of context window)
- Modifying L5/L6/L7 fallback ladder behavior
- Changing the token counting mechanism (`countTokens` function)

## Decisions

### Decision 1: Make chunking decision based on actual prompt token estimation

**Rationale:** The current chunking uses `countTokens()` which counts structured message tokens. But the summarization call converts messages to plain text via `_messagesToPlainText()` and wraps in an instruction template. The actual request body token count can be 3x higher. Chunking must use the same metric the hard gate uses.

**Implementation:** In `_compactPrefixBeforeLastUserAsync`:
1. Extract `_buildSummarizationPrompt()` helper to avoid duplicating the prompt template
2. Create a `promptTokenCounter` closure that estimates actual prompt tokens using `_messagesToPlainText()` + `_buildSummarizationPrompt()`
3. Use existing `_splitMessagesIntoChunks()` with the custom counter (no new function needed)
4. `maxChunkPromptTokens` = `contextWindow * 0.60` (60% of context window, 25% headroom below 85% hard gate)

**Alternative considered:** Create a separate `_splitMessagesIntoChunksByPromptTokens` function. **Rejected** - code duplication. The existing `_splitMessagesIntoChunks` already accepts a pluggable `countTokens` function.

### Decision 2: Change DAG routing from L2→L4 to L2→L3 when L2 doesn't improve

**Rationale:** L2 (per-tool compaction) and L3 (batched message summarization) are orthogonal strategies. L2 only processes tool messages; L3 processes all message types in batches. When there are no tool results, L2 correctly returns unchanged, but L3 could still compact the conversation prefix/suffix.

**Current code (line 379):**
```typescript
} else {
  node = "L4";  // Skip L3 entirely
}
```

**Fixed code:**
```typescript
} else {
  node = "L3";  // Try batched summarization before aggressive fallback
}
```

This ensures DAG path becomes `L1 → L2 → L3 → L4` instead of `L1 → L2 → L4`.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Prompt-based chunking adds computational overhead | Negligible - only runs for large prefixes, uses existing token counting |
| Single very large message could still exceed hard gate | 60% context window headroom provides 25% margin below hard gate; such messages are rare in practice |
| L3 may not improve when L2 didn't (no tool results) | L3 operates on all message types, not just tools. If L3 also doesn't improve, existing logic routes to L4. |
| Changing DAG routing could affect convergence behavior | L3 is less aggressive than L4 (400 vs 150 token budget). This is a more gradual escalation, which is the intended DAG design. |

## Migration Plan

1. Apply code changes to `summarization-compaction.ts`
2. Run existing unit tests (663 tests) to verify no regression
3. Run compaction E2E tests (7 tests) to verify large history handling
4. Deploy - no database migrations or config changes needed

## Open Questions

None - the fixes are straightforward and well-understood.