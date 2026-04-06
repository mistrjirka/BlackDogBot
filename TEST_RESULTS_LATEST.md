# Test Run Results — Apr 3, 2026 (after llama.cpp update)

## Summary
- Tests **completed** (not a deadlock/timeout) — ~20 min total
- GPU idle at end, process exited normally
- 19 failures across 5 test files

---

## 1. cron-schedule.test.ts — 6/10 failed (429s)

**Error: `500 Failed to parse input at pos XXX: [XML tool tags]`**

The XML parsing issue is **NOT fixed** by the llama.cpp update. Same error as before.

Failed tests:
- should add a daily scheduled task at specific time
- should add a task with interval and no specific start time
- should add a task with custom interval and start minute
- should edit a task's schedule interval
- should create a multi-step cron workflow with database
- should understand schedule format when asked directly (assertion: expected 0 >= 1)

---

## 2. per-table-tools.test.ts — 8/63 failed (412ms)

| Test | Error | Root Cause |
|------|-------|------------|
| should prefix tool name on collision | expected 4 to be 2 | buildPerTableToolsAsync now creates update tools too (4 total vs expected 2) |
| should return structured error for missing NOT NULL columns | Received tool input did not match expected schema | LangChain throws before Zod validation |
| should use numeric suffix when prefixed name also collides | expected 4 to be 2 | Same as above |
| should register and trigger rebuild callbacks | expected {...} to have property "write_table_hotreload_test" | triggerRebuildAsync returns IRebuildResult, tests assert on boolean |
| should not crash when no callback is registered | expected {success: false, ...} to be false | Same return type change |
| should unregister callbacks correctly | expected {success: false, ...} to be false | Same return type change |
| should return false when callback throws | expected {success: false, ...} to be false | Same return type change |
| should flag column as required when notNull=true | Received tool input did not match expected schema | Same NOT NULL schema issue |

---

## 3. database-crud-e2e.test.ts — 3/21 failed (77ms)

| Test | Error | Root Cause |
|------|-------|------------|
| should update data via per-table update tool | Cannot read properties of undefined (reading 'toLowerCase') | Test bug: passes `string[]` instead of `IColumnInfo[]` at line 142 |
| should return error for missing NOT NULL columns | Received tool input did not match expected schema | Same NOT NULL schema issue |
| should return error for update with no columns set | Database "col_error_db" already exists | Test isolation: DB name reused without cleanup |

---

## 4. factory-reset.test.ts — 1/10 failed (345ms)

| Test | Error | Root Cause |
|------|-------|------------|
| should delete chat-checkpoints.db | promise resolved "undefined" instead of rejecting | Promise resolves instead of rejecting |

---

## 5. tool-coverage.test.ts — 1/37 failed (798s)

| Test | Error | Root Cause |
|------|-------|------------|
| add_cron > should add a new scheduled task | 500 Failed to parse input at pos 101: [XML tool tags] | Same llama.cpp XML parsing issue |

---

## Key Findings

1. **XML parsing NOT fixed** — llama.cpp update did NOT resolve the `500 Failed to parse input` error. Qwen3.5 still emits XML tool tags in content field.

2. **No deadlock** — tests ran to completion. Slow due to LLM calls (cache misses on prompts).

3. **13 fixable test bugs** — not related to llama.cpp:
   - 8 per-table-tools: return type changes + tool count changes
   - 3 database-crud-e2e: test bug + NOT NULL schema + DB name collision
   - 1 factory-reset: promise rejection
   - 1 tool-coverage: same XML issue
