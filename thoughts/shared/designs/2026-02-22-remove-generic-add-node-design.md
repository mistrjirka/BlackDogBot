---
date: 2026-02-22
topic: "Remove generic add_node tool"
status: validated
---

# Remove Generic `add_node` Tool

## Problem Statement

The generic `add_node` tool accepts any node type with a freeform `config: Record<string, unknown>`. This bypasses strict schema validation in dedicated typed tools (e.g. `add_agent_node`), leading to nodes with malformed configs that crash at execution time with cryptic errors like "config.selectedTools is not iterable".

The generic tool is registered in the **always-available** tools set, so the LLM sees it alongside the properly-gated dedicated tools during creation mode and sometimes picks the wrong one.

## Constraints

- Every non-start node type has a dedicated `add_<type>_node` tool with strict schemas
- Start nodes are created automatically by `start_job_creation` — never manually
- No functionality is lost by removing the generic tool

## Approach

Full deletion of the generic `add_node` tool — file, schema, registration, exports, and all references. Plus a defensive guard in the executor for `config.selectedTools` as belt-and-suspenders.

## Changes

### Delete
- `src/tools/add-node.tool.ts` — the tool implementation file

### Modify
- `src/shared/schemas/tool-schemas.ts` — remove `addNodeToolInputSchema` and `addNodeToolOutputSchema`
- `src/agent/main-agent.ts` — remove import of `createAddNodeTool`, remove `add_node` from always-available tools registration, remove `"add_node"` from `_GraphMutatingTools` array
- `src/tools/index.ts` — remove `createAddNodeTool` export
- `src/services/job-executor.service.ts` — add defensive guard before iterating `config.selectedTools`: validate it's a non-empty array, throw descriptive error if not

### Defensive Guard (executor)
Before the `for (const toolName of config.selectedTools)` loop in `_executeAgentAsync`, add:
```
if (!Array.isArray(config.selectedTools) || config.selectedTools.length === 0) {
  throw new Error("Agent node config is invalid: selectedTools must be a non-empty array.");
}
```

## Testing Strategy

- `pnpm tsc --noEmit` must pass
- All existing tests must pass (no test depends on the generic `add_node` tool — integration tests use `JobStorageService.addNodeAsync` directly)

## Open Questions

None.
