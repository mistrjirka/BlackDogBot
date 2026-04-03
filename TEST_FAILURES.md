# Test Failures

> From full test run: 79/84 files passed, 799/819 tests passed

## database-crud-e2e.test.ts (3 failures)

1. `Database CRUD E2E > full CRUD workflow > should update data via per-table update tool`
   - `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
   - Location: `src/tools/update-table.tool.ts:27:58`

2. `Database CRUD E2E > error handling > should return error for missing NOT NULL columns`
   - `Error: Received tool input did not match expected schema`

3. `Database CRUD E2E > error handling > should return error for update with no columns set`
   - `Error: Database "col_error_db" already exists`
   - Location: `src/helpers/litesql.ts:152:11`

## factory-reset.test.ts (1 failure)

4. `factoryResetAsync > should delete chat-checkpoints.db`
   - `AssertionError: promise resolved "undefined" instead of rejecting`

## per-table-tools.test.ts (7 failures)

5. `Per-Table Write Tools > buildPerTableToolsAsync > should prefix tool name on collision (same table name in different databases)`
   - `AssertionError: expected 4 to be 2`

6. `Per-Table Write Tools > write table runtime validation > should return structured error for missing NOT NULL columns`
   - `Error: Received tool input did not match expected schema`

7. `Per-Table Write Tools > Name collision resolution > should use numeric suffix when prefixed name also collides`
   - `AssertionError: expected 4 to be 2`

8. `Per-Table Write Tools > Hot-reload service > should register and trigger rebuild callbacks`
   - `AssertionError: expected { success: true, …(4) } to have property "write_table_hotreload_test"`
   - Location: `tests/integration/core/per-table-tools.test.ts:453:29`

9. `Per-Table Write Tools > Hot-reload service > should not crash when no callback is registered`
   - `AssertionError: expected { success: false, …(4) } to be false`

10. `Per-Table Write Tools > Hot-reload service > should unregister callbacks correctly`
    - `AssertionError: expected { success: false, …(4) } to be false`

11. `Per-Table Write Tools > Hot-reload service > should return false when callback throws`
    - `AssertionError: expected { success: false, …(4) } to be false`

12. `Per-Table Write Tools > write table NOT NULL bug fix > should flag column as required when notNull=true and defaultValue is empty string`
    - `Error: Received tool input did not match expected schema`

## cron-schedule.test.ts (7 failures)

13. `Cron Schedule - Add Tasks with New Format > should add a daily scheduled task at specific time`
    - `Error: 500 Failed to parse input at pos 233` — LLM server parse error on XML function call

14. `Cron Schedule - Add Tasks with New Format > should add a task with interval and no specific start time`
    - `Error: 500 Failed to parse input at pos 229` — LLM server parse error

15. `Cron Schedule - Add Tasks with New Format > should add a task with custom interval and start minute`
    - `Error: 500 Failed to parse input at pos 195` — LLM server parse error

16. `Cron Schedule - Edit Tasks > should edit a task's start time`
    - `Error: 500 Failed to parse input at pos 72` — LLM server parse error

17. `Cron Schedule - Remove Tasks > should remove a scheduled task`
    - `AssertionError: expected 2 to be greater than or equal to 3`
    - Location: `tests/integration/tools/cron-schedule.test.ts:357:39`

18. `Cron Schedule - Complex Scenarios > should create a multi-step cron workflow with database`
    - `Error: 500 Failed to parse input at pos 281` — LLM server parse error

19. `Cron Schedule - Complex Scenarios > should understand schedule format when asked directly`
    - `AssertionError: expected 0 to be greater than or equal to 1`
    - Location: `tests/integration/tools/cron-schedule.test.ts:409:33`

## live-trace.test.ts (1 failure)

20. `Live Tool Trace > should invoke onStepAsync callback during LLM execution with precise timing`
    - `AssertionError: expected 0.8293065061433166 to be less than 0.8`
    - Location: `tests/integration/tools/live-trace.test.ts:179:37`
