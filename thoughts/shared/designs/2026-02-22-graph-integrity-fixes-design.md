---
date: 2026-02-22
topic: "Graph Integrity Fixes + Max Steps + Multi-Schedule Guidance"
status: validated
---

# Graph Integrity Fixes

## Problem Statement

Four bugs/gaps in the current system:

1. **Ghost connections after node removal** — `deleteNodeAsync()` deletes the node file but leaves stale references in other nodes' `connections[]` arrays and the job's `entrypointNodeId`.
2. **Start nodes accept incoming connections** — `connect_nodes` tool has no validation preventing edges INTO start nodes. Start nodes are entry points; they receive external input only.
3. **Max steps still 40** — `DEFAULT_AGENT_MAX_STEPS` in `constants.ts` is 40; should be 150.
4. **No multi-schedule guidance** — Users try to set multiple schedules on one job. The system supports one schedule per job; the creation guide doesn't mention this.

## Constraints

- All fixes must be backward-compatible
- Existing tests must continue to pass
- New tests must detect regression of each bug
- Tests use real storage (temp HOME, singleton resets) — no mocks for storage
- Follow existing test patterns in `tests/integration/`

## Approach

### Fix 1: Ghost Connections — Extend `deleteNodeAsync()`

Modify `JobStorageService.deleteNodeAsync()` (line 275) to:

1. After deleting the node file, call `this.listNodesAsync(jobId)` to get remaining nodes
2. For each remaining node: if `node.connections` contains the deleted `nodeId`, filter it out and call `this.updateNodeAsync(jobId, node.nodeId, { connections: filteredConnections })`
3. Call `this.getJobAsync(jobId)` — if `job.entrypointNodeId === nodeId`, call `this.updateJobAsync(jobId, { entrypointNodeId: undefined })` to clear it

This is the correct location because `deleteNodeAsync` is the single deletion point used by both `remove_node` tool and `clear_job_graph` tool. The cleanup is idempotent.

### Fix 2: Block Connections TO Start Nodes — Extend `connect_nodes` tool

In `connect-nodes.tool.ts`, after fetching `toNode`, add:

```
if toNode.type === 'start' → return { success: false, message: "Cannot connect to a start node — start nodes are entry points and receive no input from other nodes." }
```

Place this check before the cycle detection and schema compatibility checks (fail fast).

### Fix 3: Max Steps — Change constant

In `src/shared/constants.ts` line 41, change `DEFAULT_AGENT_MAX_STEPS` from `40` to `150`.

### Fix 4: Multi-Schedule Guidance

In `src/defaults/prompts/job-creation-guide.md`, in the `<job_scheduling>` section, add a note:

> Each job supports exactly ONE schedule. If the user needs different schedules (e.g., every 30 minutes AND every 12 hours), create SEPARATE jobs — one for each schedule.

## Architecture

No architectural changes. All fixes are localized:

- `src/services/job-storage.service.ts` — `deleteNodeAsync()` gains cleanup logic
- `src/tools/connect-nodes.tool.ts` — gains start-node validation
- `src/shared/constants.ts` — constant value change
- `src/defaults/prompts/job-creation-guide.md` — text addition

## Components

| Component | Change | Responsibility |
|-----------|--------|----------------|
| `JobStorageService.deleteNodeAsync()` | Add connection cleanup + entrypoint check | Ensure graph integrity on node deletion |
| `connect_nodes` tool | Add start-node guard | Prevent invalid graph topology |
| `DEFAULT_AGENT_MAX_STEPS` | 40 → 150 | Allow longer agent reasoning chains |
| `job-creation-guide.md` | Add multi-schedule note | Guide LLM to create separate jobs |

## Data Flow

### Node Deletion (Fix 1)
1. Tool calls `storageService.deleteNodeAsync(jobId, nodeId)`
2. Service deletes node file
3. **NEW**: Service lists remaining nodes
4. **NEW**: Service filters `nodeId` from each remaining node's `connections[]`
5. **NEW**: Service checks/clears `entrypointNodeId` if it pointed to deleted node
6. Service emits `graph_changed` event

### Connection Validation (Fix 2)
1. Tool fetches `fromNode` and `toNode`
2. **NEW**: If `toNode.type === 'start'`, reject immediately
3. Existing: cycle detection, schema compatibility check
4. Push `toNodeId` to `fromNode.connections[]`

## Error Handling

- Fix 1: If cleanup of a specific remaining node fails, log a warning but continue cleaning other nodes. The node file deletion is already done — partial cleanup is better than none.
- Fix 2: Return structured error `{ success: false, message: "..." }` — same pattern as existing schema incompatibility errors.

## Testing Strategy

### New test file: `tests/integration/remove-node-cleanup.test.ts`

Follow the existing pattern from `connect-nodes-validation.test.ts`:
- Temp HOME, singleton resets, real storage
- Helper to create job with 3+ connected nodes

Tests:
1. **"should remove deleted node from other nodes' connections"** — Create A→B→C, delete B, verify A.connections no longer contains B's nodeId
2. **"should clear entrypointNodeId when entrypoint node is deleted"** — Set entrypoint to node A, delete A, verify job.entrypointNodeId is falsy
3. **"should not affect connections to non-deleted nodes"** — Create A→B, A→C, delete C, verify A.connections still contains B's nodeId

### Extend: `tests/integration/connect-nodes-validation.test.ts`

Add test:
4. **"should reject connection to a start node"** — Try to connect B→A where A is a start node. Expect `success: false` and message containing "start node".

### New test file: `tests/unit/constants.test.ts`

5. **"DEFAULT_AGENT_MAX_STEPS should be at least 150"** — Import constant, assert `>= 150`.

## Open Questions

None — all fixes are well-scoped with clear solutions.
