## Why

The compaction DAG fails to compact large uncompacted conversation histories from previous sessions. Two critical bugs prevent proper compaction:

1. **L1 chunked summarization doesn't trigger**: The chunking logic uses `countTokens()` (structured message token count) to decide chunk boundaries, but the actual request body sent to the LLM uses plain text format with verbose labels (`[User]:`, `[Assistant]:`, `[Tool call]:`, `[Tool result]:`) that inflates token count by 15-25%. A chunk measured at 30k tokens by `countTokens()` can produce a 35k+ token request body, exceeding the 93.5k hard gate. The first L1 call sends the entire 97k token prefix instead of chunked pieces.

2. **DAG skips L3 batched summarization**: When L2 (per-tool compaction) finds no tool results to compact, it returns unchanged messages. The DAG routing logic at line 379 jumps directly to L4 (aggressive batched), bypassing L3 (normal batched) entirely. L3 could still compact the conversation messages even when there are no tool results for L2.

Both issues cause the DAG to fail on large histories, requiring multiple failed LLM calls before eventually converging via L4+L5 fallback.

## What Changes

- **Fix L1 chunking metric**: Change chunk size threshold from 30k to 20k tokens (conservative headroom for text expansion overhead), or switch to measuring actual prompt text token count
- **Fix DAG routing after L2**: When L2 doesn't improve, route to L3 instead of L4, enabling batched message summarization even without tool results
- **Add safety check**: Pre-flight validation that single-shot chunks won't exceed hard gate before attempting summarization

## Capabilities

### New Capabilities
- `compaction-chunking-safety`: Ensures L1 chunked summarization requests stay within hard gate limits by using conservative chunk sizing and pre-flight validation
- `compaction-dag-l3-routing`: Ensures DAG attempts L3 batched summarization after L2 regardless of whether L2 improved

### Modified Capabilities
- `compaction-dag`: DAG routing logic modified to attempt L3 before L4 when L2 doesn't improve
- `compaction-prefix-chunking`: Chunk size threshold reduced from 30k to 20k tokens for safety margin

## Impact

**Affected code:**
- `src/utils/summarization-compaction.ts`:
  - `_compactPrefixBeforeLastUserAsync` (L1 Stage A chunking logic)
  - `_splitMessagesIntoChunks` (chunk boundary calculation)
  - `_compactViaDagAsync` (DAG routing logic at L2→L3 transition)
  - `_compactSinglePassAsync` (L1 stage orchestration)

**No API changes** - internal implementation fixes only.
**No breaking changes** - fixes improve reliability of existing compaction behavior.