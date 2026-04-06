# Task: Harden Cron Test Assertions + withStructuredOutput Patch

## What was done

1. **Hardened integration test assertions** in `tests/integration/tools/cron-schedule.test.ts`:
   - Added `assertTaskCreated()` helper that checks scheduler state after cron creation
   - Applied to all create tests (daily task, interval task, custom interval, edit workflow, remove workflow, complex scenario)
   - This makes tests FAIL when `add_cron` doesn't actually create a task

2. **Fixed `isLlamaCppParseError`** in `src/utils/context-error.ts`:
   - Was checking `!combined.includes("context")` which false-positived on "context7_resolve-library-id" in tool lists
   - Fixed to check only for "context size", "context limit", "context exceeded"
   - Fixed `_isAPICallError` to also detect errors with `status` field (OpenAI SDK uses `status`, not `statusCode`)
   - Fixed `_getStatusCode` to check `statusCode`, `status`, and `code` fields
   - Fixed `isContextExceededApiError` to not match when error contains "failed to parse input"

3. **Created patch** `src/defaults/model-profiles/patches/disable-thinking-for-structured-output.yaml`:
   - Sets `enable_thinking: false` in `chatTemplateKwargs`
   - Purpose: activate grammar enforcement in llama.cpp for `withStructuredOutput` calls

4. **Updated code** to use `withStructuredOutput` with `disableThinking: true` in:
   - `src/tools/add-cron.tool.ts` (instruction verification)
   - `src/tools/edit-cron-instructions.tool.ts` (instruction verification)
   - `src/services/cron-message-history.service.ts` (novelty/dispatch decisions)

5. **Updated unit test mocks** to match `withStructuredOutput` pattern

## Current state

- Code uses `withStructuredOutput` + `disableThinking: true` per-call
- Profile has `activePatches: [disable-thinking-for-structured-output]` enabled
- Unit tests: 502/502 passing

## What still needs proving

The user wants TDD proof that the patch fixes the issue:
1. Run `add_cron` integration test WITHOUT `disableThinking: true` in code AND WITHOUT the patch → prove it FAILS with "400 Failed to initialize samplers"
2. Enable the patch → run test → prove it PASSES

## Potentially obsolete .md files

Files that look superseded or stale (older than last week, from completed work):

| File | Last Modified | Notes |
|------|---------------|-------|
| `TEST_FAILURES.md` | 2026-04-03 | Earlier debugging session, likely superseded |
| `TEST_RESULTS_LATEST.md` | 2026-04-03 | Earlier test run, likely superseded |
| `KNOWN_ISSUES.md` | 2026-04-03 | Some issues may be fixed now |
| `thoughts/ledgers/CONTINUITY_ses_*.md` (5 files) | 2026-03-22 | Old session continuity files |
| `thoughts/ledgers/integration-failures-2026-02-22.md` | 2026-03-22 | Very old |
| `thoughts/shared/plans/2026-02-21-*.md` (2 files) | 2026-03-22 | Old February plans |
| `thoughts/shared/plans/2026-02-22-*.md` (4 files) | 2026-03-22-23 | Old February plans |
| `thoughts/shared/designs/2026-02-22-*.md` (3 files) | 2026-03-22-23 | Old February designs |
| `docs/migration/PHASE2_NOTES.md` | 2026-03-25 | Migration notes |
| `MIGRATION_PLAN.md` | 2026-03-25 | Migration plan |
| `.mindmodel/patterns/orphaned-config-pattern.md` | 2026-03-23 | Old pattern file |
| `brain-interface/README.md` | 2026-03-22 | Old |
