## 1. DAG-level try/catch + per-stage resilience (P0 — MUST be before Task 3)

- [ ] 1.1 Import `isContextExceededApiError` from `./context-error.js` in `summarization-compaction.ts`
- [ ] 1.2 Wrap node execution in `_compactViaDagAsync` (lines 226-247) with try/catch
- [ ] 1.3 On any error: log warning with node name/phase/error, set `nextMessages = beforeMessages`, let existing `improved` routing handle advancement
- [ ] 1.4 Within `_compactSinglePassAsync` (L1): wrap each stage (A, B, C) in try/catch — on error, log warning and continue to next stage (prevents partial work loss)
- [ ] 1.5 Within `_compactToolResultsIndividuallyAsync` (L2): wrap each tool summarization in try/catch — on error, log warning and skip that tool (prevents partial work loss)
- [ ] 1.6 Verify L1→L2→L3→L4 routing still works when a node throws

## 2. Chunked multi-pass prefix summarization (L1) (P0)

- [ ] 2.1 Add `CHUNK_SIZE_TOKENS = 30_000` constant
- [ ] 2.2 In `_compactPrefixBeforeLastUserAsync`: split `unpinnedPrefixMessages` into chunks by token budget
- [ ] 2.3 Preserve message boundaries — don't split a message across chunks
- [ ] 2.4 Summarize each chunk via `_summarizeMessagesSingleShotAsync` with ~800 token budget
- [ ] 2.5 If multiple chunks, combine summaries via `_summarizeTextAsync` with "combine chunks" instruction
- [ ] 2.6 Re-attach pinned summary messages to the result
- [ ] 2.7 Add info-level logging for chunking (number of chunks, tokens per chunk)

## 3. Remove silent catch block + fix success-path placeholder (P0 — MUST be after Task 1)

- [ ] 3.1 Remove the catch block in `_summarizeTextAsync` (lines 1145-1154)
- [ ] 3.2 Fix success-path placeholder (lines 1142-1144): throw error instead of returning placeholder when LLM returns empty text
- [ ] 3.3 Errors now propagate to DAG-level try/catch (Task 1)

## 4. Batched per-message summarization replaces truncation (L3) (P1)

**NOTE**: Current `_truncateToolResultsAsync` is SYNCHRONOUS despite the `Async` suffix. The replacement MUST be async and the dispatch MUST use `await`.

- [ ] 4.1 Create `async function _compactBatchedMessagesAsync` returning `Promise<ModelMessage[]>`
- [ ] 4.2 Group adjacent uncompacted messages into batches of 5-10 messages
- [ ] 4.3 Skip already-compacted messages: `[COMPACTED TOOL RESULT]`, `[EARLIER CONTEXT SUMMARY]`, system messages, latest user
- [ ] 4.4 Skip messages below 200 chars
- [ ] 4.5 Summarize each batch via `_summarizeTextAsync` with 400-token budget
- [ ] 4.6 Replace the batch with the summary in the message array
- [ ] 4.7 Stop when `countTokens(result) <= targetTokenCount`
- [ ] 4.8 Replace L3 node dispatch in `_compactViaDagAsync` to call `await _compactBatchedMessagesAsync(...)` with `aggressive: false`
- [ ] 4.9 Remove `_truncateToolResultsAsync` function

## 5. Aggressive batched summarization replaces cropping (L4) (P1)

**NOTE**: Current `_cropMessagesFallbackAsync` is SYNCHRONOUS despite the `Async` suffix. The replacement MUST be async and the dispatch MUST use `await`.

- [ ] 5.1 Reuse `_compactBatchedMessagesAsync` with `aggressive: true` (150-token budget)
- [ ] 5.2 Replace L4 node dispatch in `_compactViaDagAsync` to call `await _compactBatchedMessagesAsync(...)` with `aggressive: true`
- [ ] 5.3 Remove `_cropMessagesFallbackAsync` function

## 6. Instrument multimodal fallback ladder (P2)

- [ ] 6.1 Add `logger.warn` when `_applyMultimodalFallbackLadder` is invoked
- [ ] 6.2 Log the reason (DAG didn't converge) and the fallback stages applied

## 7. Consolidate HARD_GATE_THRESHOLD_PERCENTAGE + fix test import (P2)

**NOTE**: `tests/unit/context-overflow.test.ts:2` imports `HARD_GATE_THRESHOLD_PERCENTAGE` from `base-agent.js`. Must re-export from `base-agent.ts` to avoid breaking the test.

- [ ] 7.1 Add `HARD_GATE_THRESHOLD_PERCENTAGE = 0.85` to `src/shared/constants.ts`
- [ ] 7.2 In `base-agent.ts`: replace local definition with `export { HARD_GATE_THRESHOLD_PERCENTAGE } from "../shared/constants.js"` (re-export)
- [ ] 7.3 In `ai-provider.service.ts`: import from `../shared/constants.js` instead of local definition
- [ ] 7.4 Verify `tests/unit/context-overflow.test.ts` still compiles (re-export preserves the import path)

## 8. Verify callers and integration (P2)

- [ ] 8.1 Verify `contextWindow` flows through from `base-agent.ts` (already passed at line 796)
- [ ] 8.2 Add `contextWindow` to `cron-message-history.service.ts` compaction call (currently missing)
- [ ] 8.3 Note: `retry-orchestrator.ts` does not call `compactMessagesSummaryOnlyAsync` directly — no action needed

## 9. Unit testing (P2)

- [ ] 9.1 Verify TypeScript compilation passes (`tsc --noEmit`)
- [ ] 9.2 Run existing unit tests: `npm run test:unit`
- [ ] 9.3 Add unit test: chunked summarization splits large prefix into chunks (mock `generateTextWithRetryAsync`)
- [ ] 9.4 Add unit test: DAG advances to next node when L1 throws (mock error propagation)
- [ ] 9.5 Add unit test: batched per-message summarization (L3) reduces tokens without truncation
- [ ] 9.6 Add unit test: aggressive batched summarization (L4) produces shorter summaries
- [ ] 9.7 Add unit test: errors from `_summarizeTextAsync` propagate to DAG, not swallowed
- [ ] 9.8 Add unit test: hard gate errors are handled by DAG try/catch
- [ ] 9.9 Add unit test: success-path empty response throws instead of returning placeholder

## 10. Real LLM integration testing (P2)

- [ ] 10.1 Add e2e test: chunked compaction with ~55k token prefix (follows pattern from `summarization-compaction.e2e.test.ts`)
- [ ] 10.2 Add e2e test: DAG fallback when summarization hits hard gate (verify L3/L4 activate)
- [ ] 10.3 Add e2e test: batched per-message summarization produces valid summaries (inspect captured exchanges)
- [ ] 10.4 Use `withChatCaptureAsync` helper to intercept and inspect all summarization API calls
- [ ] 10.5 Guard tests with `endpointReachable` check (skips if `localhost:2345` is down)
- [ ] 10.6 Set test timeout to 900000ms (15 min) for compaction e2e tests
