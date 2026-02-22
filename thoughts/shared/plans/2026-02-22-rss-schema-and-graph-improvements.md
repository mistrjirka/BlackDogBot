---
date: 2026-02-22
topic: "RSS schema auto-apply, clear graph tool, ASCII graph in results"
status: active
---

# Implementation Plan: RSS Schema + Graph Improvements

## Overview
Four improvements to fix RSS schema issues and improve graph creation UX:
1. RSS fetcher schema auto-apply (disable outputSchema input)
2. Add clear_job_graph tool
3. Add graphAscii to tool results
4. Clear creation mode when job removed

---

## Task 1: RSS fetcher schema auto-apply

### File: src/shared/schemas/tool-schemas.ts
- Create new `addRssFetcherNodeToolInputSchema` that does NOT include `outputSchema`
- Fields: jobId, parentNodeId (optional), name, description, url, mode, maxItems

### File: src/tools/add-rss-fetcher-node.tool.ts
- Remove `outputSchema` from execute args
- Define `RSS_OUTPUT_SCHEMA` constant with canonical schema
- Pass constant to `createNodeAsync`
- Update tool description

### Test: tests/integration/rss-fetcher-schema.test.ts
- Test add_rss_fetcher_node without outputSchema succeeds
- Test created node has canonical RSS schema

---

## Task 2: Add clear_job_graph tool

### File: src/tools/clear-job-graph.tool.ts (new)
- Input: `{ jobId: string }`
- Delete all nodes, edges, tests, clear entrypoint
- Return: `{ success, message, clearedNodesCount, graphAscii }`

### File: src/tools/index.ts
- Export new tool

### File: src/agent/main-agent.ts
- Add to nodeCreationTools

### Test: tests/integration/clear-job-graph.test.ts
- Test clearing job with nodes
- Test clearedNodesCount correct
- Test graphAscii returned

---

## Task 3: Add graphAscii to tool results

### Files to modify:
- src/tools/add-node.tool.ts
- src/tools/remove-node.tool.ts
- src/tools/connect-nodes.tool.ts
- src/tools/disconnect-nodes.tool.ts
- src/tools/add-rss-fetcher-node.tool.ts
- src/tools/add-agent-node.tool.ts
- src/tools/add-python-code-node.tool.ts
- src/tools/add-litesql-node.tool.ts

### Changes:
- Import `buildAsciiGraph` utility
- Fetch updated job after mutation
- Add `graphAscii` to success return

---

## Task 4: Clear creation mode when job removed

### File: src/tools/remove-job.tool.ts
- Import JobCreationModeTracker
- If removed job ID matches creation mode job, clear tracker

---

## Verification
- `pnpm tsc --noEmit`
- Run tests for rss-fetcher-schema and clear-job-graph
