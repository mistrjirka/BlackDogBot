# Antipattern Fixes and Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement validated antipattern fixes with strict TDD, including configurable 10-minute generation timeout floor, cron DAG compaction migration, fallback hardening, unsafe-cast removal, helper deduplication, and embedding typing cleanup.

**Architecture:** Centralize timeout floor policy in AI provider + retry pipeline, converge cron history compaction to the same DAG compactor used by agent flows, and remove unsafe typing/duplication via focused refactors backed by regression tests.

**Tech Stack:** TypeScript, Vitest, AI SDK (`ai`), existing BlackDogBot services/utilities.

---

### Task 1: Global Generation Timeout Floor (10m default)

**Files:**
- Modify: `src/shared/types/config.types.ts`
- Modify: `src/shared/schemas/config.schemas.ts`
- Modify: `src/services/ai-provider.service.ts`
- Modify: `src/utils/llm-retry.ts`
- Modify: `docs/configuration.md`
- Add: `tests/unit/utils/llm-retry.timeout-policy.test.ts`
- Modify: `tests/unit/ai-provider-unit.test.ts`

- [ ] **Step 1: Write failing timeout-floor tests (RED)**

Create `tests/unit/utils/llm-retry.timeout-policy.test.ts` with explicit assertions that timeout scheduling uses floor:

```ts
it("elevates schema_extraction policy timeout (60s) to 10-minute floor", async () => {
  await expectTimeoutResolutionAsync(
    generateTextWithRetryAsync({
      model: makeMockModel(),
      prompt: "test",
      retryOptions: { callType: "schema_extraction", maxAttempts: 1 },
    }),
    600_000,
  );
});
```

- [ ] **Step 2: Run RED tests**

Run: `pnpm vitest run tests/unit/utils/llm-retry.timeout-policy.test.ts`

Expected: FAIL because floor policy is not yet enforced consistently.

- [ ] **Step 3: Implement minimal timeout-floor behavior (GREEN)**

In `src/services/ai-provider.service.ts`:
- add/get `getGenerationTimeoutFloorMs()` that returns `max(ai.generationTimeoutMs ?? 600000, 600000)`.

In `src/utils/llm-retry.ts`:
- use `AiProviderService.getInstance().getGenerationTimeoutFloorMs()` in `getEffectiveTimeout`.
- apply `getEffectiveTimeout(...)` for both text/object retry paths.

In config:
- add `ai.generationTimeoutMs` in type+schema with min/default semantics.
- update `requestTimeout` docs from 500s to 600s.

- [ ] **Step 4: Add provider-clamp tests (RED)**

Extend `tests/unit/ai-provider-unit.test.ts` with cases:
- requestTimeout below floor => clamped to 600000
- missing requestTimeout => default 600000
- generationTimeoutMs above minimum => floor honored
- requestTimeout above floor => preserved

- [ ] **Step 5: Run RED provider tests**

Run: `pnpm vitest run tests/unit/ai-provider-unit.test.ts`

Expected: FAIL before clamping logic is implemented.

- [ ] **Step 6: Implement provider timeout clamping (GREEN)**

In local-provider `initializeAsync` path set:

```ts
const generationTimeoutFloor: number = Math.max(
  aiConfig.generationTimeoutMs ?? MIN_GENERATION_TIMEOUT_FLOOR_MS,
  MIN_GENERATION_TIMEOUT_FLOOR_MS,
);
this._requestTimeoutMs = configuredTimeout
  ? Math.max(configuredTimeout, generationTimeoutFloor)
  : DEFAULT_REQUEST_TIMEOUT_MS;
```

- [ ] **Step 7: Verify Task 1 tests pass**

Run:
- `pnpm vitest run tests/unit/utils/llm-retry.timeout-policy.test.ts tests/unit/ai-provider-unit.test.ts`

Expected: PASS.


### Task 2: Migrate Cron History Compaction to DAG Compactor

**Files:**
- Modify: `src/services/cron-message-history.service.ts`
- Add: `tests/unit/services/cron-message-history.compaction-dag.test.ts`
- Modify: `tests/unit/services/cron-message-history.shared.test.ts` (if needed)

- [ ] **Step 1: Write failing DAG compaction tests (RED)**

Create tests asserting:
- compaction uses DAG utility when threshold exceeded,
- bounded retention behavior is preserved,
- compaction failure keeps service alive and bounds history.

- [ ] **Step 2: Run RED tests**

Run: `pnpm vitest run tests/unit/services/cron-message-history.compaction-dag.test.ts`

Expected: FAIL before migration.

- [ ] **Step 3: Implement DAG migration (GREEN)**

In `src/services/cron-message-history.service.ts`:
- map cron history to `ModelMessage[]` representation,
- call `compactMessagesSummaryOnlyAsync(...)`,
- map/retain bounded recent cron history after compaction,
- log DAG metadata (`converged`, `passes`, `dagTerminationReason`, token reduction).

- [ ] **Step 4: Implement bounded fallback on thrown compaction**

Keep catch-and-continue behavior, but trim to bounded window so growth cannot run away.

- [ ] **Step 5: Verify tests pass**

Run:
- `pnpm vitest run tests/unit/services/cron-message-history.compaction-dag.test.ts`
- `pnpm vitest run tests/unit/services/cron-message-history.shared.test.ts`

Expected: PASS.


### Task 3: Cron Novelty/Dispatch Fallback Hardening

**Files:**
- Modify: `src/services/cron-message-history.service.ts`
- Add: `tests/unit/services/cron-message-history.fallbacks.test.ts`
- Modify: `tests/unit/tools/send-message.validation.test.ts`

- [ ] **Step 1: Write failing fallback-classification tests (RED)**

Add tests for:
- novelty failure => `isNewInformation: true` (intentional),
- dispatch failure transient => `shouldDispatch: true`,
- dispatch failure deterministic (auth/config/schema) => `shouldDispatch: false`.

- [ ] **Step 2: Run RED tests**

Run: `pnpm vitest run tests/unit/services/cron-message-history.fallbacks.test.ts`

Expected: FAIL before classification logic.

- [ ] **Step 3: Implement dispatch failure classification (GREEN)**

In `checkMessageDispatchPolicyAsync` catch:
- classify errors via existing error helpers/status context,
- return fail-open only for transient classes,
- fail-closed for deterministic classes.

- [ ] **Step 4: Verify send_message integration behavior**

Update tool-level tests to assert suppression for fail-closed policy errors.

- [ ] **Step 5: Run tests**

Run:
- `pnpm vitest run tests/unit/services/cron-message-history.fallbacks.test.ts`
- `pnpm vitest run tests/unit/tools/send-message.validation.test.ts`


### Task 4: Remove `as unknown as` Casts

**Files:**
- Modify: `src/services/scheduler.service.ts`
- Modify: `src/agent/main-agent.ts`
- Modify: `src/utils/token-tracker.ts`
- Modify/Add tests around those paths

- [ ] **Step 1: Add failing tests for each casted path (RED)**

Create/extend tests to cover:
- scheduler legacy schedule migration,
- steering message construction path,
- image token tracking branch.

- [ ] **Step 2: Run RED tests**

Run targeted tests for each area.

- [ ] **Step 3: Replace casts with typed helpers/guards (GREEN)**

Implement explicit construction and narrowing, no double assertions.

- [ ] **Step 4: Re-run targeted tests**

Expected: PASS.


### Task 5: Deduplicate Date-like Column Helper

**Files:**
- Modify: `src/utils/per-table-tools.ts`
- Modify: `src/tools/update-table.tool.ts`
- Modify tests:
  - `tests/unit/services/per-table-tools.test.ts`
  - `tests/unit/tools/update-table.tool.test.ts`

- [ ] **Step 1: Add failing test guarding shared behavior (RED)**
- [ ] **Step 2: Remove duplicate helper, import shared one (GREEN)**
- [ ] **Step 3: Run targeted tests**


### Task 6: Replace ONNX `as any` with Typed Adapter

**Files:**
- Modify: `src/services/embedding.service.ts`
- Modify tests:
  - `tests/unit/embedding-local-fallback.test.ts`

- [ ] **Step 1: Add failing typing-behavior test around backend provider selection (RED)**
- [ ] **Step 2: Introduce narrow local adapter interface and remove `as any` (GREEN)**
- [ ] **Step 3: Run embedding tests**


### Task 7: Verification Pass

**Files:**
- No new files (verification only)

- [ ] **Step 1: Run all targeted suites touched above**

```bash
pnpm vitest run \
  tests/unit/utils/llm-retry.timeout-policy.test.ts \
  tests/unit/ai-provider-unit.test.ts \
  tests/unit/services/cron-message-history.compaction-dag.test.ts \
  tests/unit/services/cron-message-history.fallbacks.test.ts \
  tests/unit/services/cron-message-history.shared.test.ts \
  tests/unit/tools/send-message.validation.test.ts \
  tests/unit/token-tracker.image-estimation.test.ts \
  tests/unit/services/per-table-tools.test.ts \
  tests/unit/tools/update-table.tool.test.ts \
  tests/unit/embedding-local-fallback.test.ts
```

- [ ] **Step 2: Run full unit suite**

Run: `pnpm vitest run`

- [ ] **Step 3: Check git working tree scope**

Run: `git status --short` and ensure only intended files changed.
