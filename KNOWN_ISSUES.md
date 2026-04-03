# Known Issues

> Auto-generated from codebase antipattern analysis.

## High Priority

### Structured Output Contract Violations

#### 1. `src/tools/add-cron.tool.ts:237`
**Issue:** Prompt explicitly asks for JSON output but uses `model.invoke()` with manual JSON.parse instead of `withStructuredOutput`.
**Impact:** Malformed LLM responses may cause unpredictable behavior; no schema enforcement.
**Fix:** Use `model.withStructuredOutput(schema).invoke()` instead.

#### 2. `src/tools/edit-cron-instructions.tool.ts:321`
**Issue:** Same as above - prompt requests JSON but uses manual parsing.
**Impact:** Same as above.
**Fix:** Use `withStructuredOutput` with a Zod schema.

#### 3. `src/services/cron-message-history.service.ts:197`
**Issue:** `_invokeStructuredDecisionAsync` calls `model.invoke()` without `withStructuredOutput` for dispatch policy and novelty checks.
**Impact:** LLM may return non-JSON or malformed JSON, causing heuristic fallback to activate.
**Fix:** Use `withStructuredOutput` with `MessageDispatchPolicySchema` / `MessageNoveltySchema`.

#### 4. `src/agent/langchain-main-agent.ts:419-426`
**Issue:** When JSON.parse fails on tool output status, defaults to `success: true` (fail-open).
**Impact:** Parse failures are silently treated as success, masking real errors.
**Fix:** Fail closed - if parsing fails, do not default to success.

### Over-Catching / Silent Failure Masking

#### 5. `src/helpers/knowledge.ts:59`
**Issue:** `JSON.parse(result.metadata)` failure silently returns `{}`, masking data corruption.
**Impact:** Corrupted metadata is invisible; downstream code operates on empty object.
**Fix:** Log the error at minimum; consider throwing or returning a result with error flag.

#### 6. `src/helpers/rss-state.ts:32-39`
**Issue:** Returns `null` for ALL errors, not just ENOENT. Real failures (parse errors, permission errors) are masked.
**Impact:** RSS state corruption goes undetected.
**Fix:** Only catch ENOENT; rethrow schema/parse errors.

#### 7. `src/services/channel-registry.service.ts:282-286`
**Issue:** If channels.yaml is corrupted, it's silently replaced with empty config. No alarm, no backup.
**Impact:** All channel configuration is lost without notification.
**Fix:** Fail closed on config corruption; preserve corrupted file for inspection.

#### 8. `src/services/scheduler.service.ts:396-401`
**Issue:** Corrupted task files are silently skipped. User loses scheduled tasks without notification.
**Impact:** Scheduled tasks disappear silently.
**Fix:** Log as error; move corrupted files to a backup location.

#### 9. `src/services/scheduler.service.ts:514-518`
**Issue:** Migration failures are silently skipped with `warn`. Old-format tasks may not run.
**Impact:** Tasks remain in old format and may not be scheduled correctly.
**Fix:** Log as error; consider failing startup if migration is critical.

#### 10. `src/utils/request-token-counter.ts:57-69`
**Issue:** Parse error returns permissive zeros. Downstream code may make decisions based on 0 tokens.
**Impact:** Token counting decisions may be wrong, leading to context overflow or under-utilization.
**Fix:** Throw error or return null; don't return permissive zeros.

## Medium Priority

### Structured Output - Heuristic Fallbacks

#### ~~11. `src/tools/add-cron.tool.ts:101-127`~~ ✅ RESOLVED
**Status:** Fixed by migration to `withStructuredOutput`. The heuristic fallback helpers no longer exist.

#### ~~12. `src/tools/edit-cron-instructions.tool.ts:144-167`~~ ✅ RESOLVED
**Status:** Same as #11.

#### ~~13. `src/services/cron-message-history.service.ts:161-188`~~ ✅ RESOLVED
**Status:** Same as #11.

### Structured Output - Content/Reasoning Merge

#### ~~14. `src/tools/add-cron.tool.ts:250-253`~~ ✅ RESOLVED
**Status:** Fixed by migration to `withStructuredOutput`. The rawText/rawReasoningText merge pattern no longer exists.

#### ~~15. `src/tools/edit-cron-instructions.tool.ts:334-337`~~ ✅ RESOLVED
**Status:** Same as #14.

#### ~~16. `src/services/cron-message-history.service.ts:211-214`~~ ✅ RESOLVED
**Status:** Same as #14.

#### 17. `src/services/providers/reasoning/reasoning-normalizer.service.ts:54-59`
**Issue:** If `structuredToolCalls` is empty, falls back to parsing tool calls from `reasoningContent` text.
**Impact:** Reasoning content becomes authoritative source for tool calls rather than supplementary signal.
**Status:** Accepted — intentional compatibility layer for LLM providers that don't return structured tool calls.
**Fix:** N/A — removing this would break providers that only emit tool calls in text.

### Code Duplication

#### ~~18. `src/tools/add-cron.tool.ts` + `src/tools/edit-cron-instructions.tool.ts` + `src/services/cron-message-history.service.ts`~~ ✅ RESOLVED
**Status:** The duplicated helper functions were removed during the `withStructuredOutput` migration.

#### 19. `src/tools/add-cron.tool.ts:36` + `src/tools/edit-cron-instructions.tool.ts:30`
**Issue:** `IInstructionVerificationResult` interface defined identically in 2 files.
**Impact:** Duplication; changes must be applied twice.
**Status:** Defer — 3-line local interfaces with no runtime impact. Both use identical Zod schemas.

#### 20. `src/tools/build-cron-tools.ts:64-107`
**Issue:** Uses `z.ZodObject<any>` and `as any` to bypass Zod internals.
**Impact:** Type safety bypassed; runtime errors possible.
**Status:** Accepted — unavoidable with Zod's dynamic enum limitation. `z.enum()` requires compile-time tuples but table names are discovered at runtime.

### Exception Control Flow

#### 21. `src/helpers/litesql.ts:117-152, 330-366`
**Issue:** Uses `throw` for validation errors (table doesn't exist, invalid database name) instead of returning error results.
**Impact:** Callers must use try/catch for expected validation failures.
**Status:** Partial — all callers handle errors appropriately via try/catch or pre-validation. Multi-file refactor for marginal gain.

### Deep Nesting

#### 22. `src/agent/langchain-main-agent.ts:370-430`
**Issue:** Tool output parsing callback nesting.
**Status:** Defer — actual max depth is 4 (not 6+), sequential branching not pyramid-of-doom. Well-commented with clear `parseSource` labels.

### Large Functions

#### 23. `src/agent/langchain-main-agent.ts:312-583`
**Issue:** `processMessageForChatAsync` ~270 lines.
**Status:** Defer — well-structured with clear sections. Callback extraction possible but low ROI given the function's cohesive nature.

#### 24. `src/tools/run-cmd.tool.ts:32-295`
**Issue:** `runCmdTool` ~260 lines with background/foreground branching and stdin detection.
**Status:** Defer — linear flow, max depth 3, clean early returns for background mode. 264 lines is reasonable for this complexity.

### God Files

#### 25. `src/services/scheduler.service.ts` (899 lines)
**Issue:** Mixes task management, scheduling, migration, concurrency control, and file I/O.
**Status:** Defer — navigable with `#region` blocks. Migration/concurrency already partially factored out.

#### 26. `src/services/embedding.service.ts` (696 lines)
**Issue:** Mixes multiple providers (local/openrouter), device resolution, model loading, CUDA handling.
**Status:** Accepted — well-organized with `#region` blocks. Multi-provider services naturally grow large; no silent error masking.

### Magic Numbers

#### ~~27. `src/services/scheduler.service.ts:654-655`~~ ✅ RESOLVED
**Status:** Extracted to module-level constants `DRAIN_POLL_INTERVAL_MS = 25` and `MAX_DRAIN_WAIT_MS = 30000`.

### Over-Catching (Medium)

#### 28. `src/services/cron-message-history.service.ts:188-191`
**Issue:** Vector store failure silently continues, disabling dedup.
**Status:** Accepted — logged at `warn` level. Intentional graceful degradation for a non-critical secondary feature.

#### ~~29. `src/helpers/skill-state.ts:20-31`~~ ✅ RESOLVED
**Status:** Now distinguishes ENOENT (expected) from other errors. Non-ENOENT errors are logged at `error` level before returning default state.

#### ~~30. `src/services/prompt.service.ts:334-336`~~ ✅ RESOLVED
**Status:** Now distinguishes ENOENT (expected) from other errors. Non-ENOENT errors are logged at `warn` level with error details before returning null.

## Low Priority / Accepted

| # | File | Line | Issue | Status |
|---|------|------|-------|--------|
| 31 | `src/services/tool-hot-reload.service.ts` | 119-124 | Returns success:true with empty tools on failure | Accepted - graceful degradation |
| 32 | `src/platforms/registry.ts` | 120-125 | Platform init failure continues to next | Accepted - one platform shouldn't block others |
| 33 | `src/platforms/telegram/handler.ts` | 400-407 | Progress edit failure silently ignored | Accepted - fallback UX behavior |
| 34 | `src/services/factory-reset.service.ts` | 135-138 | Continues despite step failures | Accepted - collecting errors for final report |
| 35 | `src/index.ts` | 35-134 | Explicit initialization order required | Accepted - documented startup sequence |
| 36 | `src/services/scheduler.service.ts` | 334-340 | Directory read failure returns silently | Accepted - logged as warning, no tasks loaded |
