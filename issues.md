# BetterClaw Issues (Validated)

## High

1. Telegram queue handoff race window
   - File: `src/platforms/telegram/handler.ts:337`
   - Problem: The per-chat `_processing` lock was released before queued processing started via a fire-and-forget call, allowing a small race where a new update could bypass queue serialization.
   - Fix: Reworked queue handoff to an awaited drain loop (`_drainQueuedMessagesAsync`) so queued batches are processed before lock release.

2. Telegram queued-path formatting inconsistency
   - File: `src/platforms/telegram/handler.ts:461`
   - Problem: Normal path converted markdown to Telegram HTML, but merged queued path sent raw chunks, producing different output formatting depending on timing.
   - Fix: Queued path now uses the same sender flow (`sender(result.text)`), preserving formatting behavior.

## Medium

3. Duplicate Discord message split implementation
   - Files: `src/platforms/discord/handler.ts:190`, `src/platforms/discord/adapter.ts:45`
   - Problem: Message splitting logic was duplicated in two classes.
   - Fix: Extracted shared `splitMessageByLength` utility in `src/utils/message-split.ts` and used it in both places.

4. Duplicate cancel command detection
   - Files: `src/platforms/telegram/handler.ts:141`, `src/platforms/discord/handler.ts:130`
   - Problem: Identical cancel parsing duplicated.
   - Fix: Extracted shared `isCancelCommand` utility in `src/utils/command-utils.ts`.

5. Unsafe `as any` for platform lifecycle state
   - Files: `src/platforms/telegram/index.ts:57`, `src/platforms/discord/index.ts:61`
   - Problem: Lifecycle state storage used `as any`, reducing type safety.
   - Fix: Added explicit private state interfaces (`ITelegramPlatformState`, `IDiscordPlatformState`) and removed `as any` there.

6. Direct console logging in rate limiter service
   - File: `src/services/rate-limiter.service.ts:129`
   - Problem: Used `console.log` instead of centralized logger.
   - Fix: Switched to `LoggerService.info(...)` with metadata.

## Low

7. Unused deprecated table helper
   - File: `src/utils/telegram-format.ts:177`
   - Problem: `wrapMarkdownTablesInCodeBlocks` was deprecated and had no call sites.
   - Fix: Removed the dead deprecated function.

8. Residual non-project root artifacts
   - Files: `test_lmstudio_request.mjs`, `test_lmstudio_request2.mjs`, `test_lmstudio.mjs`, `test_lmstudio.js`, `test-msg-dump.ts`, `test-tool-call2.ts`, `test.log`, `test`
   - Problem: Root-level ad-hoc/testing artifacts make repo noisier and can confuse maintenance.
   - Status: Not auto-removed in this change; recommend manual review before deletion.

## Additional note

- `src/index.ts` uses `allowedInstallKinds as any` and `src/tools/setup-skill.tool.ts` used `allowedKinds as any`.
- Fix: Introduced exported `SkillInstallKind` type from `src/helpers/skill-installer.ts` and removed these casts.

## Retry Unification & Cancel Reliability (March 2026)

### Issues Fixed

9. Stacked retry layers causing invisible retry storms
   - Problem: AI SDK internal retries (default 2) stacked with local retry loops, causing repeated identical requests that appeared "mysterious" in logs.
   - Fix: Extended `src/utils/llm-retry.ts` with explicit retry policy options (`maxAttempts`, `timeoutMs`, `abortSignal`, `callType`) and disabled SDK retries (`maxRetries: 0`) in all `generateText` calls.

10. Helper LLM calls (compaction/summarization) blocking cancel
    - Problem: Tool-result compaction, summarization, and cron history helpers ran without abort propagation, so `/cancel` couldn't interrupt them.
    - Fix: Added `abortSignal` to `ICompactionOptions`, threaded through `CompactionContext`, and implemented timeout-based abort in retry helpers.

11. Deterministic cancel semantics
    - Problem: `/cancel` only dropped the latest queued message, leaving other queued messages to run after cancel.
    - Fix: Updated Telegram handler to clear ALL queued messages on cancel (not just the latest), with best-effort deletion of all prompt messages.

12. Logging clarity for retries
    - Problem: No correlation ID to tie retry attempts together; unclear which layer retried.
    - Fix: Added `llmCallId` (UUID) to all retry logs, explicit `retryLayer` field, `sdkRetriesDisabled: true` flag, and `isAbort` detection.

### Files Changed

- `src/utils/llm-retry.ts` - Extended API with explicit retry options, disabled SDK retries, added correlation IDs
- `src/utils/tool-result-compaction.ts` - Added abortSignal support to compaction options and context
- `src/utils/summarization-compaction.ts` - Added explicit callType for retry policy
- `src/services/cron-message-history.service.ts` - Added explicit callType
- `src/services/job-executor.service.ts` - Added explicit callType to extraction calls
- `src/tools/create-output-schema.tool.ts` - Removed nested retry loop, uses single retry layer
- `src/tools/add-cron.tool.ts` - Added explicit callType
- `src/tools/edit-cron.tool.ts` - Added explicit callType
- `src/platforms/telegram/handler.ts` - Clear all queued messages on cancel

### Retry Policy by Call Type

| Call Type | maxAttempts | timeoutMs |
|-----------|-------------|-----------|
| agent_primary | 3 | 120000 |
| tool_compaction | 2 | 45000 |
| summarization | 2 | 60000 |
| schema_extraction | 2 | 60000 |
| cron_history | 1 | 30000 |
| job_execution | 2 | 60000 |
