# Phase 4 — Job Creation Graph Topology Fix

## Problem

When the AI creates multi-step jobs (e.g., "fetch news → filter → store"), it
connects all nodes directly to the Start node (star topology) instead of chaining
them sequentially. This breaks data flow because each node receives the Start
node's raw trigger input instead of the previous node's output.

## Root Cause

The `job-creation-guide.md` prompt (read-only reference, not auto-injected) has
no explicit graph topology guidance, worked examples, or anti-pattern warnings.
The `main-agent.md` `<job_creation>` section only says "specify parentNodeId to
auto-connect" — the word "parent" is ambiguous and doesn't convey chaining.

When the agent enters job creation mode, the current system prompt only has the
brief `<job_creation>` section. The full guide is never dynamically injected.

## Solution

### 1. Enhance `job-creation-guide.md` (add `<graph_topology>` section)

Add a `<graph_topology>` section between `</design_principles>` and `<node_types>`
with:
- Sequential pipeline pattern with 3 concrete worked examples showing exact
  `parentNodeId` chaining
- CRITICAL anti-pattern section: star topology with explanation of why it breaks
- Fan-out pattern for legitimate parallel branches
- Rule of thumb: "Does node B need the output of node A? Then A must be B's parent"

### 2. Enhance `base-agent.ts` (_buildAgent signature)

Add a 9th optional parameter:
```ts
getCreationModePrompt?: () => string | null
```

In `prepareStep`, when `useExtraTools` is true (creation mode active), return:
```ts
{ system: instructions + "\n\n" + creationPrompt, activeTools: activeToolNames }
```
This injects the full job creation guide into the system prompt dynamically only
when the agent is in job creation mode.

### 3. Update `main-agent.ts`

At `initializeAsync()` time, load `job-creation-guide.md` via `PromptService`:
```ts
const jobCreationGuide: string = await promptService.getPromptAsync("job-creation-guide");
```

Pass a closure as the 9th arg to `_buildAgent`:
```ts
(): string | null => session.jobCreationMode !== null ? jobCreationGuide : null,
```

## Files Modified

| File | Change |
|---|---|
| `src/defaults/prompts/job-creation-guide.md` | Add `<graph_topology>` section |
| `src/agent/base-agent.ts` | Add 9th `getCreationModePrompt` param to `_buildAgent`; inject in `prepareStep` |
| `src/agent/main-agent.ts` | Load guide at init; pass lambda as 9th arg to `_buildAgent` |

## Verification

- `npx tsc --noEmit` — clean
- `cd brain-interface && pnpm build` — clean (no frontend changes expected)

## Status

- [ ] job-creation-guide.md enhanced
- [ ] base-agent.ts updated
- [ ] main-agent.ts updated  
- [ ] tsc clean
