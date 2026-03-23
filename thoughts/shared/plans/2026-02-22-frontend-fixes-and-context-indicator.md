---
date: 2026-02-22
topic: "Frontend fixes, run_node_test output, context usage indicator"
status: active
---

# Implementation Plan: Frontend Fixes & Context Usage Indicator

## Overview

Three work streams:
1. Fix broken build by extracting node detail panel into its own component
2. Fix `run_node_test` to include output + toolCallHistory in LLM response
3. Add context usage indicator to frontend status bar

---

## Task 1: Extract Node Detail Panel Component (HIGH PRIORITY — BUILD IS BROKEN)

**Problem:** `graph.scss` is 15.1kB, exceeding Angular's 8kB `anyComponentStyle` budget. The executor added ~346 lines of detail panel styles inline.

**Solution:** Extract the node detail panel (overlay + sidebar) into a new standalone component at `brain-interface/src/app/components/node-detail/`.

### Files to create:
- `brain-interface/src/app/components/node-detail/node-detail.html`
- `brain-interface/src/app/components/node-detail/node-detail.ts`
- `brain-interface/src/app/components/node-detail/node-detail.scss`

### Component spec:
- **Selector:** `app-node-detail`
- **Standalone:** true
- **ChangeDetection:** OnPush
- **Inputs (signals):**
  - `node: InputSignal<INode | null>` — the selected node
  - `tests: InputSignal<INodeTestCase[]>` — test cases for the node
  - `testResults: InputSignal<Map<string, INodeTestResult>>` — results map
  - `isRunningTest: InputSignal<string | null>` — currently running test ID
- **Outputs:**
  - `closed: OutputEmitterRef<void>` — emitted when user clicks close or backdrop
  - `runTest: OutputEmitterRef<INodeTestCase>` — emitted when user clicks run test button

### Migration steps:
1. Move ALL `.node-detail-overlay`, `.node-detail-panel`, and child styles from `graph.scss` → `node-detail.scss`
2. Move the `<!-- Node Detail Panel -->` template block from `graph.html` → `node-detail.html`
3. Update template references: `closeNodeDetail()` → `closed.emit()`, `onRunTest(test)` → `runTest.emit(test)`, `selectedNode()` → `node()`, etc.
4. In `graph.html`, replace the detail panel block with: `<app-node-detail [node]="selectedNode()" [tests]="selectedNodeTestList()" [testResults]="testResults" [isRunningTest]="isRunningTest" (closed)="closeNodeDetail()" (runTest)="onRunTest($event)" />`
5. Import `NodeDetailComponent` in `graph.ts`
6. Remove the moved styles from `graph.scss`
7. Keep `selectedNodeId`, `showNodeDetail`, `selectedNode`, `selectedNodeTestList`, `onNodeClick`, `closeNodeDetail` signals/methods in `graph.ts` — they drive the visibility
8. Keep `.graph-node.selected` style in `graph.scss` (it belongs to the graph, not the detail panel)
9. Verify `pnpm ng build` passes (SCSS under 8kB each)

### Make sections expandable:
- Config values, schema JSON blocks, and test input/output currently have `max-height: 200px` with overflow hidden
- Add a boolean signal per section (`configExpanded`, `inputSchemaExpanded`, etc.) or a generic `Set<string>` of expanded section IDs
- Toggle `max-height: none` when expanded
- Add a small "Show more" / "Show less" button below truncated sections
- Use CSS `overflow: hidden` + `max-height` transition for smooth expand/collapse

---

## Task 2: Fix run_node_test Output (HIGH PRIORITY)

**Problem:** `run-node-test.tool.ts` maps results but explicitly omits `output` field. The LLM never sees what the node actually produced, making it hard to debug failing tests.

### Step 2a: Add IAgentToolCall type
**File:** `src/shared/types/job.types.ts`
**Add after INodeTestResult:**
```
export interface IAgentToolCall {
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
}
```

### Step 2b: Extend INodeTestResult
**File:** `src/shared/types/job.types.ts`
**Add to INodeTestResult interface:**
```
toolCallHistory?: IAgentToolCall[];
```

### Step 2c: Capture tool call history in job-executor.service.ts
**File:** `src/services/job-executor.service.ts`
**In `_executeAgentAsync`, after the existing step iteration (lines 890-903):**
- Build a `toolCallHistory: IAgentToolCall[]` array by iterating `agentResult.steps`
- For each step, for each `toolCall`, push `{ toolName, input, output: toolResult }`
- Capture all tool calls in history (final output is returned as text)
- Include `toolCallHistory` in the returned result

### Step 2d: Include output and toolCallHistory in run-node-test response
**File:** `src/tools/run-node-test.tool.ts`
**Change the result mapping (lines 22-32) to include:**
```
output: r.output,
toolCallHistory: r.toolCallHistory,
```

---

## Task 3: Context Usage Indicator (MEDIUM PRIORITY)

**Problem:** User wants to see how much context the LLM is consuming and how close it is to the compaction threshold.

### Current state:
- `base-agent.ts` has `DEFAULT_COMPACTION_TOKEN_THRESHOLD = 80000` and uses tiktoken to count tokens
- Status bar already shows `contextTokens` from `IStatusState`
- `StatusService` emits `status_update` via socket with `inputTokens` and `contextTokens`

### Step 3a: Emit context usage data from backend
**File:** `src/services/status.service.ts` (or wherever `IStatusState` is defined)
**Add to IStatusState:**
```
compactionThreshold?: number;
compactionPercentage?: number;  // 0-100, how close to compaction
```

**File:** `src/agent/base-agent.ts`
**In `prepareStep` (around line 147), after counting tokens:**
- Call `statusService.setContextUsage(tokenCount, threshold)` or include in the existing status update
- Calculate percentage: `Math.round((tokenCount / threshold) * 100)`
- Emit via existing status_update event

### Step 3b: Display in frontend status bar
**File:** `brain-interface/src/app/components/graph/graph.html`
**In the status bar, after the existing context tokens display:**
- Add a visual progress bar showing context fill level
- Show: "📊 45,231 / 80,000 tokens (57%)"
- Color code: green (<50%), yellow (50-75%), red (>75%)

**File:** `brain-interface/src/app/components/graph/graph.ts`
- Add computed signals: `compactionPercentage`, `compactionThreshold` derived from `status()`
- Add computed: `contextBarColor` based on percentage thresholds

**File:** `brain-interface/src/app/components/graph/graph.scss`
- Add `.context-bar` styles: thin horizontal bar with fill indicator
- Use existing color scheme: green → `#4fc3f7`, yellow → `#ffd54f`, red → `#e94560`

---

## Execution Order

1. **Task 1 FIRST** — build is broken, nothing else can be verified until this is fixed
2. **Task 2** — backend-only change, straightforward
3. **Task 3** — new feature, touches both backend and frontend

## Verification

After each task:
- `pnpm ng build` must pass (frontend)
- `pnpm tsc --noEmit` must pass (backend)
- Run any existing integration tests that touch the modified code
