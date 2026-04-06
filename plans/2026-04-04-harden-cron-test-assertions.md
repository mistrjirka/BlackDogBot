# Harden Cron Test Assertions

> **Goal:** Make cron creation tests detect the `400 Failed to initialize samplers` failure they currently let slip.

**Architecture:** Tighten integration test assertions to verify side effects (scheduler state or agent text) rather than only checking "agent responded." TDD flow: first add assertions that prove the bug exists (tests fail), then fix the underlying `withStructuredOutput` incompatibility so tests pass.

**Tech Stack:** vitest, SchedulerService, LangchainMainAgent

---

## Files to modify

| File | What changes |
|------|-------------|
| `tests/integration/tools/cron-schedule.test.ts` | Add scheduler-based task-exists checks after each create |
| `tests/integration/tools/tool-coverage.test.ts` | Add text-based success assertion for `add_cron` |
| `tests/integration/tools/cron-schedule.test.ts` | Add `SchedulerService` import for scheduler verification |

## Files NOT in scope

- `tests/unit/tools/add-cron.tool.test.ts` — already correctly tests mocked error handling
- `tests/integration/tools/cron-agent.test.ts` — tests cron *execution*, not creation
- `tests/integration/core/scheduler-execution.test.ts` — tests scheduler service directly, correct

---

### Task 1: Add scheduler verification to `cron-schedule.test.ts`

**Files:**
- Modify: `tests/integration/tools/cron-schedule.test.ts`

**Context:** `cron-schedule.test.ts` already starts `SchedulerService` in `beforeAll` (line 65) and cleans up via `createdTaskIds` in `afterAll`. We need to verify tasks actually exist in the scheduler after creation.

- [ ] **Step 1: Add `assertTaskCreated` helper**

Insert after `extractTaskIdsFromResponse` (line 152):

```typescript
function assertTaskCreated(taskName: string): void {
  const scheduler = SchedulerService.getInstance();
  const tasks = scheduler.getAllTasks();
  const found = tasks.find(t => t.name === taskName);
  if (!found) {
    throw new Error(
      `Task "${taskName}" was NOT created in scheduler. ` +
      `Existing tasks: ${tasks.map(t => t.name).join(", ") || "(none)"}`
    );
  }
}
```

- [ ] **Step 2: Tighten "should add a daily scheduled task" (line 159)**

After line 178 (`createdTaskIds.push(...taskIds)`), add:

```typescript
assertTaskCreated("daily_morning_report");
```

- [ ] **Step 3: Tighten "should add a task with interval" (line 187)**

After line 204, add:

```typescript
assertTaskCreated("hourly_health_check");
```

- [ ] **Step 4: Tighten "should add a task with custom interval" (line 213)**

After line 230, add:

```typescript
assertTaskCreated("feed_fetch_offset");
```

- [ ] **Step 5: Tighten "should edit a task's schedule" create step (line 283)**

After line 295, add:

```typescript
assertTaskCreated("edit_me_task");
```

- [ ] **Step 6: Tighten "should remove a task" create step (line 337)**

After line 349, add:

```typescript
assertTaskCreated("delete_me_task");
```

- [ ] **Step 7: Tighten "should create a multi-step cron workflow" (line 368)**

After line 387, add:

```typescript
assertTaskCreated("news_digest");
```

- [ ] **Step 8: Run `cron-schedule.test.ts` — expect FAIL**

Run: `npx vitest run tests/integration/tools/cron-schedule.test.ts --reporter=verbose`
Expected: creation tests FAIL because agent hits `400 Failed to initialize samplers` and tasks are never created in scheduler.

---

### Task 2: Add success assertion to `tool-coverage.test.ts` `add_cron` test

**Files:**
- Modify: `tests/integration/tools/tool-coverage.test.ts`

- [ ] **Step 1: Tighten `add_cron` assertion (line 226)**

Replace lines 226-227:

```typescript
expect(result.stepsCount).toBeGreaterThanOrEqual(1);
expect(result.text).toBeDefined();
```

With:

```typescript
expect(result.stepsCount).toBeGreaterThanOrEqual(1);
expect(result.text).toBeDefined();
// add_cron must have actually run successfully — not just "agent responded"
const looksLikeSuccess =
  result.text.toLowerCase().includes("scheduled") ||
  result.text.toLowerCase().includes("created") ||
  result.text.toLowerCase().includes("task") && result.text.toLowerCase().includes("added");
const looksLikeFailure =
  result.text.toLowerCase().includes("failed") ||
  result.text.toLowerCase().includes("error") ||
  result.text.toLowerCase().includes("could not");
expect(looksLikeSuccess).toBe(true);
expect(looksLikeFailure).toBe(false);
```

- [ ] **Step: Run `tool-coverage.test.ts` add_cron test — expect FAIL**

Run: `npx vitest run tests/integration/tools/tool-coverage.test.ts -t "add_cron"`
Expected: FAIL because agent text reflects the 400 sampler error.

---

### Task 3: Identify root cause and fix

After tasks 1-2 prove the failures, investigate and fix the `withStructuredOutput` incompatibility. The `add_cron` tool uses `model.withStructuredOutput(...)` which sends `response_format: json_schema` to llama.cpp. Combined with `enable_thinking: true`, this triggers `400 Failed to initialize samplers`.

**Possible fix approaches:**
- A) In `_verifyInstructionsAsync`, call `createChatModel` with `disableThinking: true` to force `enable_thinking: false` for the verifier model
- B) Replace `withStructuredOutput` with plain `invoke()` + manual JSON extraction

Approach A is minimal and targets the exact root cause (thinking + json_schema conflict).

---

### Task 4: Apply fix, verify tests turn green

- [ ] Apply chosen fix
- [ ] Re-run tasks 1-2 test commands
- [ ] Verify all previously-failing tests now PASS
