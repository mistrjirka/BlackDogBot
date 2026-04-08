# Offset Minutes Scheduler and Cron Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit `offsetMinutes` support for interval tasks, migrate existing timed task files to new format, and fix cron tool validation/context so `update_table_*` tools are usable and visible.

**Architecture:** Extend the interval schedule contract with `offsetMinutes` (minutes, not milliseconds), apply it in scheduler runtime as first-run delay then steady interval, and expose it in all cron add/edit/list surfaces. Add startup migration for legacy timed task JSON files so all persisted interval tasks have explicit `offsetMinutes`. Align cron tool validators and tool-context builder to treat both `write_table_*` and `update_table_*` as first-class dynamic tools.

**Tech Stack:** TypeScript, Zod, Vitest, Node.js scheduler (`setTimeout`, `setInterval`), JSON-backed timed task persistence.

---

## File Structure and Responsibility Mapping

- **Schedule types and schemas**
  - Modify: `src/shared/types/cron.types.ts` (canonical interval schedule type)
  - Modify: `src/shared/schemas/cron.schemas.ts` (persistence schema validation)
  - Modify: `src/shared/schemas/tool-schemas.ts` (tool input/output schemas for add/edit/list)

- **Cron tool behavior**
  - Modify: `src/tools/add-interval.tool.ts` (accept/persist `offsetMinutes`)
  - Modify: `src/tools/edit-interval.tool.ts` (patch `offsetMinutes`)
  - Modify: `src/tools/list-timed.tool.ts` (surface `offsetMinutes`)
  - Modify: `src/utils/cron-format.ts` (human-readable schedule output)

- **Scheduler runtime + migration**
  - Modify: `src/services/scheduler.service.ts` (offset-aware scheduling + legacy JSON migration)

- **Dynamic cron tool validation/context**
  - Modify: `src/tools/add-once.tool.ts`
  - Modify: `src/tools/add-interval.tool.ts`
  - Modify: `src/tools/edit-once.tool.ts`
  - Modify: `src/tools/edit-interval.tool.ts`
  - Modify: `src/tools/edit-instructions.tool.ts`
  - Modify: `src/utils/cron-tool-context.ts`

- **Tests**
  - Modify/Create: `tests/unit/timed-tool-schemas.test.ts`
  - Create: `tests/unit/services/scheduler-offset-minutes.test.ts`
  - Modify/Create: `tests/unit/tools/cron-dynamic-tool-validation.test.ts`
  - Modify/Create: `tests/unit/utils/cron-tool-context.test.ts`

### Task 1: Add `offsetMinutes` to schedule contracts and tool schemas

**Files:**
- Modify: `src/shared/types/cron.types.ts`
- Modify: `src/shared/schemas/cron.schemas.ts`
- Modify: `src/shared/schemas/tool-schemas.ts`
- Test: `tests/unit/timed-tool-schemas.test.ts`

- [ ] **Step 1: Write failing schema tests for `offsetMinutes`**

Add tests asserting:
```ts
// valid
{ type: "interval", intervalMs: 7200000, offsetMinutes: 59 }
{ type: "interval", intervalMs: 7200000, offsetMinutes: 0 }
// invalid
{ type: "interval", intervalMs: 7200000, offsetMinutes: -1 }
{ type: "interval", intervalMs: 7200000, offsetMinutes: 1.5 }
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
pnpm vitest run tests/unit/timed-tool-schemas.test.ts
```
Expected: FAIL because `offsetMinutes` not recognized/validated.

- [ ] **Step 3: Implement type + schema updates**

Update types:
```ts
export interface IScheduleInterval {
  type: "interval";
  intervalMs: number;
  offsetMinutes: number;
}
```

Update schemas:
```ts
offsetMinutes: z.number().int().nonnegative().default(0)
```

Apply to:
- persistence schedule schema
- add/edit interval tool input schemas
- list timed output schema schedule object

- [ ] **Step 4: Run test to verify pass**

Run:
```bash
pnpm vitest run tests/unit/timed-tool-schemas.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/cron.types.ts src/shared/schemas/cron.schemas.ts src/shared/schemas/tool-schemas.ts tests/unit/timed-tool-schemas.test.ts
git commit -m "feat: add offsetMinutes to interval schedule schemas"
```

### Task 2: Implement scheduler runtime behavior + legacy timed-task migration

**Files:**
- Modify: `src/services/scheduler.service.ts`
- Test: `tests/unit/services/scheduler-offset-minutes.test.ts`

- [ ] **Step 1: Write failing scheduler tests (runtime + migration)**

Add tests for:
1. `offsetMinutes > 0`: first run delayed by `offsetMinutes * 60000`, then interval cadence.
2. `offsetMinutes = 0`: behaves as normal interval.
3. Legacy task JSON without `offsetMinutes` is migrated to include `offsetMinutes: 0` and persisted.

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
pnpm vitest run tests/unit/services/scheduler-offset-minutes.test.ts
```
Expected: FAIL on scheduling/migration behavior.

- [ ] **Step 3: Implement scheduler changes**

In `SchedulerService`:
- In interval scheduling branch, compute `offsetDelayMs = schedule.offsetMinutes * 60000`.
- If `offsetDelayMs > 0`:
  - schedule first run via `setTimeout`
  - then install recurring `setInterval(intervalMs)`
- Else run existing interval behavior.
- Ensure `_unscheduleTask` clears both timeout + interval.

Migration in task loading path:
- When loading interval tasks without `offsetMinutes`, set `offsetMinutes = 0`.
- Mark migrated and save task file back to disk once normalized.

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
pnpm vitest run tests/unit/services/scheduler-offset-minutes.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduler.service.ts tests/unit/services/scheduler-offset-minutes.test.ts
git commit -m "feat: support interval offsetMinutes and migrate legacy timed tasks"
```

### Task 3: Wire `offsetMinutes` through add/edit/list/format tooling

**Files:**
- Modify: `src/tools/add-interval.tool.ts`
- Modify: `src/tools/edit-interval.tool.ts`
- Modify: `src/tools/list-timed.tool.ts`
- Modify: `src/utils/cron-format.ts`
- Test: `tests/unit/tools/*timed*.test.ts` (existing relevant tests)

- [ ] **Step 1: Write failing tool/output tests**

Add/extend tests to assert:
- `add_interval` accepts and stores `offsetMinutes`.
- `edit_interval` can patch `offsetMinutes` independently.
- `list_timed` returns `schedule.offsetMinutes`.
- `formatScheduledTask` includes offset in interval output.

- [ ] **Step 2: Run targeted tests to verify failure**

Run:
```bash
pnpm vitest run tests/unit/tools/add-interval.tool.test.ts tests/unit/tools/edit-interval.tool.test.ts tests/unit/tools/list-timed.tool.test.ts tests/unit/utils/cron-format.test.ts
```
Expected: FAIL in at least one area lacking offset support.

- [ ] **Step 3: Implement minimal wiring changes**

Add/propagate `offsetMinutes` in tool execute signatures and schedule patch/build logic.

Formatting string example:
```ts
interval: 7200000ms (offset: 59m)
```

- [ ] **Step 4: Run targeted tests to verify pass**

Run:
```bash
pnpm vitest run tests/unit/tools/add-interval.tool.test.ts tests/unit/tools/edit-interval.tool.test.ts tests/unit/tools/list-timed.tool.test.ts tests/unit/utils/cron-format.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/add-interval.tool.ts src/tools/edit-interval.tool.ts src/tools/list-timed.tool.ts src/utils/cron-format.ts tests/unit/tools/add-interval.tool.test.ts tests/unit/tools/edit-interval.tool.test.ts tests/unit/tools/list-timed.tool.test.ts tests/unit/utils/cron-format.test.ts
git commit -m "feat: expose offsetMinutes across timed cron tool surfaces"
```

### Task 4: Allow `update_table_*` in cron validators and verifier context

**Files:**
- Modify: `src/tools/add-once.tool.ts`
- Modify: `src/tools/add-interval.tool.ts`
- Modify: `src/tools/edit-once.tool.ts`
- Modify: `src/tools/edit-interval.tool.ts`
- Modify: `src/tools/edit-instructions.tool.ts`
- Modify: `src/utils/cron-tool-context.ts`
- Test: `tests/unit/tools/cron-dynamic-tool-validation.test.ts`
- Test: `tests/unit/utils/cron-tool-context.test.ts`

- [ ] **Step 1: Write failing tests for dynamic tool acceptance**

Test cases:
- accepts `write_table_news_items`
- accepts `update_table_news_items`
- rejects unknown `delete_table_news_items`

Also test tool context builder includes meaningful `update_table_*` descriptions.

- [ ] **Step 2: Run targeted tests to verify failure**

Run:
```bash
pnpm vitest run tests/unit/tools/cron-dynamic-tool-validation.test.ts tests/unit/utils/cron-tool-context.test.ts
```
Expected: FAIL due to missing `update_table_*` acceptance/context.

- [ ] **Step 3: Implement shared dynamic tool predicate and context support**

Implement/centralize predicate:
```ts
isDynamicTableTool(name) => name.startsWith("write_table_") || name.startsWith("update_table_")
```

Use predicate in all add/edit/edit_instructions validators.

In `cron-tool-context`, include descriptions for both write and update per-table tools.

- [ ] **Step 4: Run targeted tests to verify pass**

Run:
```bash
pnpm vitest run tests/unit/tools/cron-dynamic-tool-validation.test.ts tests/unit/utils/cron-tool-context.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/add-once.tool.ts src/tools/add-interval.tool.ts src/tools/edit-once.tool.ts src/tools/edit-interval.tool.ts src/tools/edit-instructions.tool.ts src/utils/cron-tool-context.ts tests/unit/tools/cron-dynamic-tool-validation.test.ts tests/unit/utils/cron-tool-context.test.ts
git commit -m "fix: allow update_table dynamic tools in cron validation and context"
```

### Task 5: End-to-end verification and regression safety

**Files:**
- Modify: `tests/integration/core/timed-task.e2e.test.ts` (or create focused integration test if absent)

- [ ] **Step 1: Add integration tests for offset + migration + dynamic update tools**

Cover:
1. Create interval with `offsetMinutes: 59`, ensure persisted and listed.
2. Load legacy task file lacking offset, ensure migration writes `offsetMinutes: 0`.
3. Task tool lists accept both `write_table_*` and `update_table_*`.

- [ ] **Step 2: Run focused integration tests**

Run:
```bash
pnpm vitest run tests/integration/core/timed-task.e2e.test.ts
```
Expected: PASS.

- [ ] **Step 3: Run global safety checks**

Run:
```bash
pnpm typecheck
pnpm test:unit
```
Expected: PASS.

- [ ] **Step 4: Commit final verification adjustments**

```bash
git add tests/integration/core/timed-task.e2e.test.ts
git commit -m "test: cover interval offsetMinutes migration and dynamic update tools"
```

---

## Self-Review Checklist

- Spec coverage:
  - `offsetMinutes` introduced and propagated end-to-end ✅
  - legacy task migration to new format ✅
  - no backward compatibility except config/task migration path ✅
  - dynamic update tools accepted by cron validators and verifier context ✅

- Placeholder scan:
  - no TODO/TBD placeholders ✅
  - all tasks include concrete files, commands, expected outcomes ✅

- Type consistency:
  - `offsetMinutes` naming consistent across types/schemas/tools/tests ✅

