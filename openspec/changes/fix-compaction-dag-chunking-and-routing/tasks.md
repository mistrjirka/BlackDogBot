## 1. Fix L1 Chunked Summarization

- [x] 1.1 Extract `_buildSummarizationPrompt()` helper to avoid duplicating the prompt template
- [x] 1.2 Create `promptTokenCounter` closure in `_compactPrefixBeforeLastUserAsync` that estimates actual prompt tokens
- [x] 1.3 Use existing `_splitMessagesIntoChunks()` with the custom counter (no new function needed)
- [x] 1.4 Set `maxChunkPromptTokens = contextWindow * 0.60` (60% of context window)
- [x] 1.5 Pass `options` through `_compactSinglePassAsync` to `_compactPrefixBeforeLastUserAsync`

## 2. Fix DAG Routing After L2

- [x] 2.1 Change L2 routing in `_compactViaDagAsync` from `node = "L4"` to `node = "L3"` when L2 doesn't improve
- [x] 2.2 Update test `summarization-compaction.dag.test.ts` to expect `["L1", "L2", "L3"]` path

## 3. Testing

- [ ] 3.1 Run TypeScript compile check
- [ ] 3.2 Run existing unit tests (663 tests) to verify no regression
- [ ] 3.3 Run compaction E2E tests (7 tests) to verify large history handling
- [ ] 3.4 Run impl-check