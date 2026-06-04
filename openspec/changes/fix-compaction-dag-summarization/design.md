## Context

The compaction DAG in `summarization-compaction.ts` attempts to reduce message history by summarizing prefix messages before the latest user message. The `_summarizeTextAsync` function converts all prefix messages to plain text and sends them as a single prompt to the LLM. However, when the prefix is large (~55k tokens), the resulting LLM request body exceeds the hard gate (93,500 tokens for an 110k context window), causing the summarization call to fail with a synthetic 400 error.

The hard gate in `ai-provider.service.ts` (`_createTokenGatedFetch`) intercepts every POST request, counts tokens via tiktoken, and rejects requests exceeding 85% of the context window. This gate applies to ALL LLM calls, including summarization calls.

Current flow:
1. DAG detects messages exceed target -> triggers L1 compaction
2. L1 calls `_compactPrefixBeforeLastUserAsync` -> converts 63 messages to plain text (~220k chars, ~55k tokens)
3. Calls `_summarizeTextAsync` with the full plain text
4. LLM SDK serializes the prompt -> request body exceeds 93,500 tokens
5. Hard gate blocks the request -> returns synthetic 400
6. Retry exhausts -> falls back to placeholder summary
7. DAG reports success but compaction was ineffective

**Critical issue (silent failure):** The catch block in `_summarizeTextAsync` (line 1145) swallows ALL errors and returns `[Summary unavailable ...]`. The DAG sees token reduction (the placeholder is small) and declares convergence. The DAG never knows that the LLM summarization step failed.

**The 40k overhead explained:** The log shows `overhead: 40404` for a single-message summarization request. This is JSON escaping overhead. `countMessagesTokens` counts raw text content, while the hard gate's `countRequestBodyTokens` counts the full JSON-serialized body where newlines become `\n`, quotes become `\"`, etc. For 220k chars of code-heavy conversation content, JSON escaping inflates the token count by ~40k. This overhead is content-dependent, not a fixed value.

**User requirements:**
- **No truncation, no cropping** — all compaction must be LLM-based summarization
- **No silent try-catch blocks** — errors must propagate, not be swallowed
- **Compaction targets a percentage of context** — already implemented (30% aggressive, 40% normal), but broken because summarization fails
- **DAG ensures high-priority parts are compacted best** — the DAG already has this structure (L1 > L2 > L3 > L4), but L3/L4 use truncation/cropping instead of LLM

## Goals / Non-Goals

**Goals:**
- Zero truncation, zero cropping — all compaction is LLM-based summarization
- No silent try-catch blocks — errors propagate to DAG, which handles them
- Summarization LLM calls never exceed the hard gate limit
- Compaction reaches the target percentage of context window (30%/40%)
- DAG detects when summarization fails and falls through to next strategy
- Consolidate duplicated `HARD_GATE_THRESHOLD_PERCENTAGE` constant
- No changes to the hard gate mechanism itself

**Non-Goals:**
- Changing the hard gate threshold
- Adding a separate summarization model endpoint
- Modifying the AI SDK or provider service
- Making compaction quality configurable by end users
- Fixing the JSON escaping overhead in the hard gate counter (work around it instead)
- Parallelizing chunk summarization (deferred)

## Decisions

### Decision 1: Consolidate HARD_GATE_THRESHOLD_PERCENTAGE
- **What**: Move `HARD_GATE_THRESHOLD_PERCENTAGE` from `base-agent.ts` to `src/shared/constants.ts`. Update `ai-provider.service.ts` to import from there.
- **Why**: The constant is duplicated in two files (`base-agent.ts` line 59, `ai-provider.service.ts` line 75). If one changes and the other doesn't, the hard gate and compaction trigger would be out of sync. Also avoids circular dependency when `summarization-compaction.ts` needs to import it.
- **How**: Add to `shared/constants.ts`, update both importers.

### Decision 2: Chunked multi-pass prefix summarization (L1)
- **What**: Replace the single-shot prefix summarization with chunked multi-pass. Split the prefix into chunks of ~30k tokens each, summarize each chunk independently, then combine the chunk summaries into one coherent summary.
- **Why**: A single-shot summarization of 55k+ tokens exceeds the hard gate. Chunking ensures each LLM call stays well under the limit. Each chunk (~30k tokens) + instruction (~200 tokens) = ~30.2k tokens of content. Even with 2x JSON escaping overhead (~60k), this is under 93.5k.
- **How**: In `_compactPrefixBeforeLastUserAsync`, split `unpinnedPrefixMessages` into chunks by token budget. Summarize each chunk via `_summarizeMessagesSingleShotAsync`. If multiple chunks, combine via `_summarizeTextAsync`.
- **Chunk size**: 30,000 tokens per chunk. Conservative enough to stay under hard gate even with JSON escaping overhead.
- **Combining**: Chunk summaries are small (~800 tokens each). Combining 3-5 summaries = ~3-4k tokens, well under hard gate.

### Decision 3: Batched per-message summarization replaces truncation (L3)
- **What**: Replace `_truncateToolResultsAsync` (hard truncation) with `_compactBatchedMessagesAsync` (LLM-based batched summarization). Group 5-10 adjacent messages into batches, summarize each batch in one LLM call.
- **Why**: The user rejects truncation. Per-message summarization of 60+ messages would require 60+ sequential LLM calls (10-60 minutes). Batching reduces this to 6-12 calls. Also skips already-compacted messages (those with `[COMPACTED TOOL RESULT]` or `[EARLIER CONTEXT SUMMARY]` markers) to avoid re-summarizing.
- **How**: Group adjacent uncompacted messages into batches of ~5-10. Summarize each batch via `_summarizeTextAsync` with 400-token budget. Replace the batch with the summary. Stop when target is reached.
- **Budget**: 400 tokens per batch summary (generous).

### Decision 4: Aggressive batched summarization replaces cropping (L4)
- **What**: Replace `_cropMessagesFallbackAsync` (message dropping + cropping) with aggressive batched summarization. Same as L3 but with shorter summaries (150 tokens).
- **Why**: The user rejects cropping. Aggressive summarization is the last-resort LLM-based strategy.
- **How**: Same as L3 but with 150-token budget per batch summary.

### Decision 5: Keep multimodal fallback ladder (L5/L6/L7) with instrumentation
- **What**: Keep the existing L5 (drop oldest), L6 (prune tool results), L7 (drop images) fallback ladder. Add warning logging when it triggers.
- **Why**: The fallback ladder is the absolute last resort when ALL LLM-based compaction fails (e.g., LLM provider down). Removing it would mean the agent crashes in edge cases. Keeping it with instrumentation ensures the user knows when it's used.
- **How**: Add `logger.warn` when `_applyMultimodalFallbackLadder` is invoked. Log the reason (DAG didn't converge).

### Decision 5: DAG-level try/catch for error handling
- **What**: Wrap each DAG node execution in try/catch. If a node throws, treat it as "no improvement" and let the existing DAG routing advance to the next node.
- **Why**: Removing the silent catch block means errors propagate. The DAG needs to handle them gracefully. Non-context errors (network, model) should not crash message processing.
- **How**: In `_compactViaDagAsync`, wrap node execution in try/catch. On error, set `nextMessages = beforeMessages` (no change). The existing `improved` check sees `false` and routes to the next node naturally.
- **Order**: MUST be implemented BEFORE removing the silent catch block.

### Decision 6: Remove silent catch block in `_summarizeTextAsync`
- **What**: Remove the catch block that swallows all errors and returns a placeholder. Let errors propagate to the DAG.
- **Why**: Silent failures hide real problems. The user explicitly rejects this pattern. Errors should propagate so the DAG can handle them.
- **How**: Remove lines 1145-1154. The DAG-level try/catch (Decision 5) handles the propagated errors.
- **Order**: MUST be implemented AFTER DAG-level try/catch is in place.

### Decision 7: Compaction targets 30%/40% of context window (existing, preserved)
- **What**: The existing targeting logic (30% aggressive, 40% normal) is preserved. The DAG iterates until `countTokens(messages) <= targetTokenCount`.
- **Why**: The user wants compaction to reach a percentage of context, not just barely under the threshold. This ensures the next message doesn't immediately trigger compaction again.
- **How**: Already implemented in `base-agent.ts` lines 784-786. The DAG's convergence check (line 264) ensures the target is reached.

## Risks / Trade-offs

[Chunked summarization loses cross-chunk context] → Mitigated by the combining step which reconstructs coherence. Some cross-chunk relationships may be lost, but this is better than truncation which loses content entirely.

[Increased latency from multiple LLM calls] → Chunked L1 requires 2-4 LLM calls instead of 1. Per-message L3/L4 require N calls for N large messages. The user explicitly prioritizes quality over speed.

[Per-message summarization may produce fragmented summaries] → Each message is summarized independently, losing conversational flow. Mitigated by L1's chunked approach which preserves context within chunks.

[DAG try/catch may hide unexpected errors] → The try/catch treats ALL errors as "no improvement". This is intentional — the DAG should always produce a result, even if imperfect. Errors are logged for debugging.

[Model context window variance across providers] → The 30k chunk size is conservative and should work for any model with 110k+ context. For smaller models, the chunk size could be reduced.

## Migration Plan

- No migration needed. This is a behavioral fix to internal compaction logic.
- No config changes required.
- Rollback: revert the changed files if issues arise.

## Open Questions

- Should chunk size be parameterized by model context window? (Not initially; 30k is conservative)
- Should we parallelize chunk summarization? (Deferred — adds complexity)
- Should per-message summarization skip messages below a size threshold? (Yes, skip messages < 200 chars)
