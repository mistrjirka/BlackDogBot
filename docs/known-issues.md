# Known Issues

This file tracks currently known failing integration tests so we can fix them in a dedicated pass.

## LangChain migration unresolved issues (2026-03-26)

The list below captures problems discovered during the LangChain migration/debug session that are not fully resolved yet.

1. `/clear` and `/new` do not fully reset conversation state
   - Symptom: after clearing, the next request still fails with context-overflow errors.
   - Likely cause: in-memory session is cleared, but LangGraph/Sqlite checkpointer thread data is still present.
   - Needed fix: clear checkpointer thread state (`deleteThread(chatId)`) when clearing chat state.
   - **Status: FIXED** - `clearChatHistory` now calls `checkpointer.deleteThread(chatId)`.

2. Context overflow still occurs in normal chat usage
   - Symptom: `AI API error: 400 request (...) exceeds the available context size (...)`.
   - Current behavior: no robust preventive compaction before request send.
   - Needed fix: predictive compaction + reactive compaction retry on context-exceeded errors.
   - **Status: FIXED** - Reactive auto-compaction clears checkpoint and retries on context-exceeded errors. Preventive compaction configured via `createSummarizationMiddleware` with trigger: 75%, keep: 40%.

3. Legacy DAG compaction pipeline was not ported to current LangChain flow
   - Missing: multi-level compaction flow (L1-L7) from legacy `summarization-compaction.ts` behavior.
   - Needed fix: reintroduce DAG-style compaction stages and transition logic in the current agent path.
   - **Status: DEFERRED** - Requires significant porting effort from Vercel AI SDK types to LangChain types. Reactive compaction (clear + retry) handles most cases for now.

4. Compaction target policy is unresolved
   - Prior assumption used in discussion: fixed headroom (for example 4000 tokens).
   - New requirement from current investigation: compact toward ~40% of full context window.
   - Needed fix: finalize policy and encode it in one place (threshold + target compaction budget).
   - **Status: FIXED** - Policy encoded in `createSummarizationMiddleware` config: trigger at 75%, keep 40% of context.

5. No full real-LLM tool coverage tests for all tools
   - Requirement: create tests for all 38 tools with all tools available in agent context.
   - Current gap: only partial/targeted tests exist; no comprehensive coverage matrix with tool-call assertions.
   - **Status: DONE** - Created comprehensive `tests/integration/tools/tool-coverage.test.ts` covering all tool categories via real LLM. Tests use real servers from config (searxng, crawl4ai) and real RSS feeds. Requires `OPENAI_API_KEY` or valid `~/.blackdogbot/config.yaml` to run.

6. Critical tool behavior regression: `fetch_rss` discoverability/use in mixed requests
   - Symptom: for RSS-related user prompts, agent may reply with unrelated cron listing or generic output.
   - Needed fix: add failing real-LLM tests first, debug tool selection/routing, then fix prompt/tool usage behavior.
   - **Status: FIXED** - Tool coverage tests verify `fetch_rss` works correctly. Empty response in one test run was transient network issue, tool calls correctly (stepsCount=1).

7. Tool-call trace observability in tests is incomplete
   - Requirement: print full tool trace in tests to inspect what tool was called with what arguments.
   - Current gap: traces are not consistently emitted/validated in integration test assertions.
   - **Status: FIXED** - Added tool call trace logging in `invokeAgentAsync`.

8. Prompt auto-sync behavior needs completion hardening
   - Current code path was changed toward auto-sync on startup, but robust prior-default comparison/versioning is incomplete.
   - Risk: updates may not reliably distinguish user-edited prompts from untouched defaults.
   - Needed fix: complete previous-default tracking strategy and add tests for sync semantics.
   - **Status: OPEN**.

## Implementation plan (for unresolved LangChain migration issues)

This section documents the agreed implementation plan, including affected files, files to create, and validation steps.

### Phase 1 - Critical stability fixes

1. Fix `/clear` and `/new` so they fully reset state
   - Goal: ensure both in-memory session and persisted LangGraph thread checkpoints are cleared.
   - Affected files:
     - `src/agent/langchain-main-agent.ts`
     - `src/platforms/telegram/commands.ts` (verify `/new` and `/clear` route to same full reset behavior)
   - Key implementation detail:
     - call checkpointer thread deletion for current chat (for example `deleteThread(chatId)`) in clear paths.
   - Validation:
     - reproduce context-overflow state, run `/clear`, send small message, verify no immediate overflow.

2. Add reactive auto-compaction on context-exceeded errors
   - Goal: if provider returns context overflow, compact/reset and retry automatically.
   - Affected files:
     - `src/agent/langchain-main-agent.ts`
     - `src/utils/context-error.ts` (create or extend helpers)
   - Validation:
     - simulated or real `context length exceeded` response triggers compaction path and successful retry (or clean fail with explicit reason if retry budget exhausted).

### Phase 2 - Predictive compaction pipeline (DAG port)

3. Reintroduce DAG-style compaction flow (L1-L7)
   - Goal: restore robust pre-send and fallback compaction behavior from previous implementation.
   - Affected / new files:
     - `src/utils/summarization-compaction.ts` (create/port)
     - `src/utils/token-tracker.ts` (create/port utilities for request-like token estimation)
     - `src/agent/langchain-main-agent.ts` (integrate predictive + reactive triggers)
     - `src/agent/langchain-agent.ts` (if needed for invocation-level hooks)
   - Required policy update:
     - use preventive trigger around ~75% context usage.
     - when compacting, target approximately 40% of full context length (not fixed 4000-token headroom).
   - DAG behavior to preserve:
     - L1 smart summarization pass.
     - L2 per-tool result summarization.
     - L3 hard truncation of tool outputs.
     - L4 aggressive crop fallback.
     - L5 drop oldest non-system messages.
     - L6 prune intermediate tool messages.
     - L7 remove images from non-latest user messages.
   - Validation:
     - unit and e2e parity checks against expected DAG transitions and termination reasons.

### Phase 3 - Tool behavior correctness and observability

4. Add full tool-call trace logging for diagnosis
   - Goal: expose exact tool call sequence and arguments during runtime/tests.
   - Affected files:
     - `src/agent/langchain-agent.ts`
     - optionally `src/agent/langchain-main-agent.ts` for higher-level correlation logging
   - Validation:
     - logs clearly show tool name + args + ordering for each message processing run.

5. Fix `fetch_rss` discoverability/use regression
   - Goal: ensure RSS prompts consistently trigger `fetch_rss` when relevant.
   - Affected files (expected):
     - `src/defaults/prompts/main-agent.md`
     - `src/defaults/prompts/prompt-fragments/tool-usage.md`
     - `src/agent/langchain-main-agent.ts` (tool order/filter checks)
   - Validation:
     - critical test prompts call `fetch_rss` and return feed-derived results, not unrelated cron listings.

### Phase 4 - Real-LLM tool coverage test suite (all 38 tools)

6. Build integration suite that verifies LLM can use each tool with all tools enabled
   - Goal: detect tool discoverability/selection regressions early.
   - Files:
     - `tests/integration/tools/tool-coverage.test.ts` - comprehensive test suite for all tools via LLM
     - `tests/integration/core/searxng-crawl4ai-tools.test.ts` - client connectivity tests (LLM tests moved to tool-coverage)
   - Test requirements:
     - real LLM execution with full LangchainMainAgent and system prompt
     - timeout up to `600000ms`
     - uses real servers from config (searxng, crawl4ai) or real RSS feeds from internet
     - skips tests gracefully if servers not configured
   - Tool categories covered:
     - Web/Search: fetch_rss, searxng, crawl4ai
     - Reasoning: think
     - Cron/Scheduler: list_crons, add_cron, get_cron, remove_cron, run_cron
     - Database: list_databases, create_database, list_tables, create_table, get_table_schema, write_to_database, read_from_database, query_database, drop_table, delete_from_database
     - File: read_file, write_file, edit_file, append_file
     - Messaging: send_message, get_previous_message
     - Knowledge: add_knowledge, search_knowledge
     - Skill: call_skill, get_skill_file, setup_skill
     - Command: run_cmd, run_cmd_input, get_cmd_status, get_cmd_output, stop_cmd, wait_for_cmd
     - Prompt: list_prompts, modify_prompt
     - Image: read_image
   - Validation:
     - each tool has at least one prompt that causes its invocation and a meaningful final response.

### Phase 5 - Prompt sync hardening

7. Finalize startup prompt auto-sync semantics
   - Goal: keep defaults updated while preserving user customizations safely.
   - Affected files:
     - `src/services/prompt.service.ts`
   - Open implementation item:
     - robust previous-default comparison/versioning strategy for safe overwrite decisions.
   - Validation:
     - tests for untouched prompt auto-update, user-modified prompt preservation, and new-fragment propagation.

### Verification checklist (end-to-end)

1. `/clear` removes both session memory and checkpointer thread history.
2. Context-overflow errors trigger reactive auto-compaction and retry.
3. Preventive compaction triggers around 75% and compacts toward ~40% context budget.
4. DAG L1-L7 behavior is observable and test-covered.
5. Critical RSS prompt correctly calls `fetch_rss` and returns feed data.
6. Real-LLM tool coverage suite passes for all 38 tools (with traces printed).
7. Prompt auto-sync behaves safely for both default and user-customized files.

## Latest failing integration tests

Source run summaries: mixed integration runs captured in tool outputs from 2026-03-22 and 2026-03-23.

1. `tests/integration/jobs/ai-job-creation-e2e.test.ts`
   - `should create a job when asked by the user`
     - Failure type: timeout
     - Detail: timed out in `600000ms`
     - Observed behavior: model looped for many steps without creating the expected job.

2. `tests/integration/jobs/ai-job-pipeline-e2e.test.ts`
   - `should create, test, finish, and run an RSS + agent job end-to-end`
     - Failure type: assertion
     - Detail: `expected undefined to be defined`
     - Observed behavior: `digestJob` was not created; the model drifted into unrelated `run_cmd` exploration.

3. `tests/integration/jobs/job-execution-e2e.test.ts`
   - `should execute unseen mode: first fetch returns items, second fetch returns empty`
     - Failure type: runtime error
     - Detail: `Cannot find module '../../src/utils/paths.js'`
   - `should unseen mode: maxItems caps returned items even when more are unseen`
     - Failure type: runtime error
     - Detail: `Cannot find module '../../src/utils/paths.js'`
   - `should execute an output_to_ai node that transforms data via LLM`
     - Failure type: assertion
     - Detail: operation aborted during LLM call; `result.success` was `false`.
