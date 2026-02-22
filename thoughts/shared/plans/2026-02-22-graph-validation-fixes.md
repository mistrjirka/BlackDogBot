# Graph Validation Fixes - Implementation Plan

## Problem Summary
AI created a graph where LITESQL node received inputs from two different parents (AGENT and PYTHON_CODE), causing duplicate data insertion. Multiple validation gaps allowed this.

## Root Causes
1. **LITESQL `inputSchema: {}`** - Schema compatibility always passes
2. **`connect_nodes` never blocks** - Incompatibility only warns, doesn't prevent
3. **No semantic validation** - No LLM-based graph audit
4. **No disconnect tool** - Can't break erroneous connections
5. **No database viewer** - Can't verify stored data

---

## Phase 1: Schema Enforcement for LITESQL Nodes

### Goal
LITESQL nodes must derive their `inputSchema` from the target table's actual column structure.

### Tasks

#### 1.1 Create `deriveLiteSqlInputSchema` utility
**File**: `src/utils/litesql-schema-helper.ts`

```typescript
// Derives JSON Schema from SQLite table schema
// - Gets table columns via LiteSqlService.getTableSchemaAsync()
// - Maps SQL types to JSON Schema types
// - Marks NOT NULL columns as required
// - Returns proper inputSchema object
```

**Logic**:
- Call `getTableSchemaAsync(databaseName, tableName)`
- Map: `INTEGER` → `type: "integer"`, `TEXT` → `type: "string"`, `REAL` → `type: "number"`
- `NOT NULL` columns → add to `required` array
- Primary key columns → optional in input (auto-generated)

#### 1.2 Update `add-litesql-node.tool.ts`
- After creating node, call `deriveLiteSqlInputSchema`
- Update node's `inputSchema` with derived schema
- If table doesn't exist yet, keep `inputSchema: {}` but flag as `schemaPending: true`

#### 1.3 Create `refresh-litesql-schema.tool.ts`
- Tool for agent to refresh a LITESQL node's inputSchema after table creation
- Useful when table is created dynamically

#### 1.4 Update schema compatibility check
**File**: `src/jobs/schema-compat.ts`

- Add stricter type checking for nested objects
- Add `strictMode` flag that fails on missing `type` properties
- Return detailed error messages with field paths

### Tests
- `tests/unit/litesql-schema-helper.test.ts` - Schema derivation logic
- `tests/integration/litesql-schema-e2e.test.ts` - End-to-end with real tables

---

## Phase 2: Connection Validation & Disconnect Tool

### Goal
Prevent invalid connections at creation time; allow breaking existing connections.

### Tasks

#### 2.1 Make `connect_nodes` respect schema compatibility
**File**: `src/tools/connect-nodes.tool.ts`

- If `checkSchemaCompatibility` returns `{ compatible: false }`:
  - Return `{ success: false, error: "Schema incompatibility", details: compatResult.errors }`
  - DO NOT create the connection
- Add `force: boolean` option to override (for expert use)

#### 2.2 Create `disconnect_nodes.tool.ts`
**New file**: `src/tools/disconnect-nodes.tool.ts`

```typescript
// Removes a connection between two nodes
// - Validates both nodes exist
// - Removes toNodeId from fromNode.connections
// - Updates storage
// - Returns success/failure
```

**Input schema**:
- `jobId: string`
- `fromNodeId: string`
- `toNodeId: string`

#### 2.3 Update agent tool registry
**File**: `src/agent/main-agent.ts`

- Register `disconnect_nodes` tool in job creation mode

#### 2.4 Add cycle detection to `connect_nodes`
- Before creating connection, check if it would create a cycle
- Use DFS from `toNode` to see if `fromNode` is reachable
- If cycle detected, return `{ success: false, error: "Would create cycle" }`

### Tests
- `tests/unit/disconnect-nodes.test.ts` - Disconnect logic
- `tests/integration/connection-validation-e2e.test.ts` - Schema blocking, cycle detection

---

## Phase 3: LLM-Based Graph Audit

### Goal
Before finishing job creation, use an LLM to semantically validate the graph makes sense.

### Tasks

#### 3.1 Create `audit-graph-logic.tool.ts` (internal tool)
**New file**: `src/tools/audit-graph-logic.tool.ts`

This is NOT exposed to the agent - it's called internally by `finish_job_creation`.

```typescript
// Generates a human-readable graph description
// Sends to LLM with audit prompt
// LLM checks for:
//   - Logical data flow issues
//   - Duplicate inputs to same node
//   - Missing transformations between incompatible data formats
//   - Nonsensical connections
// Returns { approved: boolean, issues: string[], suggestions: string[] }
```

#### 3.2 Create graph description generator
**File**: `src/utils/graph-description.ts`

```typescript
// Converts graph structure to human-readable text
// - Lists each node with type and config summary
// - Shows connections with data flow description
// - Highlights potential issues (multiple inputs, etc.)
```

#### 3.3 Create audit prompt template
**File**: `src/defaults/prompts/graph-audit.md`

```
You are a graph validation auditor. Review this job graph and identify:

1. **Data Flow Issues**: Does data flow logically? Are there transformations missing?
2. **Duplicate Inputs**: Does any node receive the same data from multiple sources unintentionally?
3. **Schema Mismatches**: Are there connections where output schema doesn't match input expectations?
4. **Redundant Nodes**: Are there unnecessary nodes that don't add value?

Graph:
{{graphDescription}}

Respond with JSON:
{
  "approved": boolean,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1", "suggestion2"]
}
```

#### 3.4 Update `finish-job-creation.tool.ts`
- After structural validation passes, call `auditGraphLogic`
- If `approved: false`:
  - Return validation errors with LLM feedback
  - DO NOT mark job as ready
  - Include suggestions for fixing

#### 3.5 Add `skipAudit` option
- For automated testing or expert use
- Still requires structural validation to pass

### Tests
- `tests/unit/graph-description.test.ts` - Description generation
- `tests/integration/graph-audit-e2e.test.ts` - LLM audit with real graphs

---

## Phase 4: Database Viewer & Job Completion Fixes

### Goal
Visibility into database contents; fix job execution completion issues.

### Tasks

#### 4.1 Create `query-database.tool.ts`
**New file**: `src/tools/query-database.tool.ts`

```typescript
// Query LITESQL database contents
// - List databases
// - List tables in a database
// - Query table contents with where/limit/order
// - Show table schema
```

**Input schema**:
```typescript
z.object({
  action: z.enum(["list_databases", "list_tables", "query_table", "show_schema"]),
  databaseName: z.string().optional(),
  tableName: z.string().optional(),
  where: z.string().optional(),
  limit: z.number().optional(),
  orderBy: z.string().optional()
})
```

#### 4.2 Fix job execution completion
**Investigation needed**: The "blinking" final node suggests execution might not be completing properly.

**Potential fixes**:
- Check if `executeJobAsync` properly awaits all node executions
- Verify status updates are sent for final nodes
- Check frontend event handling for completion

#### 4.3 Add execution status events
**File**: `src/services/job-executor.service.ts`

- Emit `job_execution_complete` event when all nodes finish
- Include summary: nodes executed, total duration, any warnings

#### 4.4 Update frontend to handle completion
**File**: `brain-interface/src/app/services/brain-socket.service.ts`

- Handle `job_execution_complete` event
- Update UI to show final status

### Tests
- `tests/unit/query-database.test.ts` - Query tool logic
- `tests/integration/job-completion-e2e.test.ts` - Full job execution with completion verification

---

## Execution Order

| Phase | Priority | Dependencies | Estimated Effort |
|-------|----------|--------------|------------------|
| Phase 1 | HIGH | None | 4-6 hours |
| Phase 2 | HIGH | Phase 1 | 3-4 hours |
| Phase 3 | MEDIUM | None | 4-5 hours |
| Phase 4 | MEDIUM | None | 3-4 hours |

**Recommended order**: Phase 1 → Phase 2 → Phase 3 → Phase 4

---

## Files to Create

1. `src/utils/litesql-schema-helper.ts`
2. `src/tools/refresh-litesql-schema.tool.ts`
3. `src/tools/disconnect-nodes.tool.ts`
4. `src/tools/audit-graph-logic.tool.ts` (internal)
5. `src/utils/graph-description.ts`
6. `src/defaults/prompts/graph-audit.md`
7. `src/tools/query-database.tool.ts`

## Files to Modify

1. `src/tools/add-litesql-node.tool.ts` - Derive inputSchema
2. `src/jobs/schema-compat.ts` - Stricter validation
3. `src/tools/connect-nodes.tool.ts` - Block on incompatibility, cycle detection
4. `src/tools/finish-job-creation.tool.ts` - Add LLM audit step
5. `src/agent/main-agent.ts` - Register new tools
6. `src/services/job-executor.service.ts` - Completion events
7. `brain-interface/src/app/services/brain-socket.service.ts` - Handle completion

---

## Test Strategy

### Unit Tests
- Schema derivation logic
- Disconnect tool
- Graph description generator
- Query database tool

### Integration Tests
- LITESQL schema enforcement with real tables
- Connection blocking on schema mismatch
- LLM graph audit with problematic graphs
- Job execution completion

### Regression Tests
- Create the exact graph from the bug report
- Verify it fails validation with proper error messages
- Fix the graph and verify it passes
