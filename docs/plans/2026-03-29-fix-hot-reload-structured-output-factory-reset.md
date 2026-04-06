# Plan: Fix Hot-Reload, Structured Output, and Factory Reset

## Context

After antipattern fixes and integration stabilization, three production issues remain:

1. **Hot-reload doesn't work**: After `create_table`, the agent can't use `write_table_<table>` in the next message because tools aren't rebuilt.
2. **Structured output broken with llama.cpp**: `withStructuredOutput` fails with "400 Failed to initialize samplers". llama.cpp can't handle `response_format: json_schema` + `enable_thinking: false` + tool calling.
3. **Factory reset checkpoint leak**: `chat-checkpoints.db` survives factory reset, old conversations leak.

## Approach: Option A

Remove `withStructuredOutput` entirely. Use `model.invoke()` + parse JSON from `content` AND `reasoning_content` + Zod schema validation everywhere. Structured output contract enforced by Zod, not API.

---

## Step 1: Fix Hot-Reload

### Root Cause
`createLangchainAgent` captures `session.tools` at creation time (line 288). The `onSchemaToolMutationAsync` callback fires INSIDE the stream loop mid-stream — too late for the already-running agent.

### Fix
- Remove `onSchemaToolMutationAsync` from `invokeAgentAsync` and `langchain-main-agent.ts`.
- Add unconditional `ToolHotReloadService.getInstance().triggerRebuildAsync(chatId)` AFTER `invokeAgentAsync` completes in `processMessageForChatAsync`.
- This rebuilds tools for the NEXT message (not current — same as old Vercel AI SDK approach).

### Files
- `src/agent/langchain-agent.ts`: remove parameter + detection logic
- `src/agent/langchain-main-agent.ts`: add rebuild after stream

### Tests
- `tests/unit/services/agent-toolcall-fallback-multiturn.test.ts`: remove schema mutation callback test, add test verifying tools rebuild after message

---

## Step 2: Fix Structured Output

### Root Cause
`withStructuredOutput` sends `response_format: json_schema` + `tools` + `enable_thinking: false` to llama.cpp. Incompatible. llama.cpp puts structured JSON in `reasoning_content` when thinking enabled.

### Fix (per tool)
Extract shared helper `_invokeStructuredAsync(schema, model, prompt)` that:
1. Calls `model.invoke(prompt)` (no `withStructuredOutput`)
2. Extracts text from `response.content` (array or string)
3. Extracts text from `response.additional_kwargs.reasoning_content`
4. Finds all top-level JSON objects in merged text
5. Validates each against Zod schema via `safeParse`
6. Returns first valid parse or throws

### Files
- `src/tools/add-cron.tool.ts`: replace verifier with shared helper
- `src/services/cron-message-history.service.ts`: replace novelty/dispatch checks
- `src/tools/edit-cron-instructions.tool.ts`: replace verification

### Tests
- `tests/unit/tools/add-cron.tool.test.ts`: mock `invoke()`, not `withStructuredOutput()`
- `tests/unit/services/cron-message-history-structured-output.test.ts`: update mocks

---

## Step 3: Fix Factory Reset

### Root Cause
`chat-checkpoints.db` at `~/.blackdogbot/chat-checkpoints.db` not in any getDir() path, so factory reset skips it.

### Fix
Add `fs.rm(checkpointDbPath, { force: true })` to factory reset service.

### Files
- `src/services/factory-reset.service.ts`: add checkpoint DB deletion

### Tests
- `tests/integration/core/factory-reset.test.ts`: verify checkpoint DB wiped

---

## Verification

1. Unit tests: all modified test files pass
2. Integration tests: `pnpm vitest tests/integration --maxWorkers 1` (full suite)
3. Manual: `pnpm start` with 30s timeout, verify no spam, verify create_table -> write_table works
