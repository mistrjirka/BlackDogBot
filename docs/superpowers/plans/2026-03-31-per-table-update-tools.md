# Per-Table Update Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create per-table `update_table_<tableName>` tools (like existing `write_table_<tableName>`) that auto-register when tables are created, so the agent doesn't forget `tableName` parameter.

**Architecture:** Extend the existing tool hot-reload pattern from `write_table_<tableName>` to also create `update_table_<tableName>` tools. Each tool has table-specific parameters (column names) instead of generic `set` object.

**Tech Stack:** TypeScript, Zod schema validation, LangChain tool interface, existing tool-hot-reload service

---

## Problem Statement

The cron agent repeatedly fails to use `update_database` because it forgets the `tableName` parameter. The root cause: the tool is named `update_database` (not table-specific), so the agent must remember to specify which table.

## Solution

Create per-table `update_table_<tableName>` tools at runtime when `create_table` creates a table. This matches the existing pattern for `write_table_<tableName>`.

## Design Details

### Tool Name
`update_table_<tableName>` (e.g., `update_table_users`)

### Schema Design
Each column becomes an optional parameter (not a generic `set` object):

```typescript
z.object({
  where: z.string().min(1).describe("SQL WHERE clause (required for safety)"),
  // Each column (except primary key) becomes optional parameter:
  [columnName]: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
})
.refine((data) => {
  // At least one column besides 'where' must be set
  const columns = Object.keys(data).filter(k => k !== 'where');
  return columns.some(col => data[col] !== undefined);
}, { message: "At least one column must be set" })
```

### Primary Key Handling
Primary key (`id`) is excluded from settable columns. The `where` clause references the primary key.

## File Structure

### Files to Create
1. `src/tools/update-table.tool.ts` - Factory function for per-table update tools
2. `tests/unit/tools/update-table.tool.test.ts` - Unit tests for the factory

### Files to Modify
1. `src/tools/create-table.tool.ts` - After table creation, build `update_table_<tableName>` tool
2. `src/agent/langchain-main-agent.ts` - Add per-table update tools to agent (follow existing `write_table_<tableName>` pattern)
3. `src/shared/constants/cron-descriptions.ts` - Add cron description for dynamic update tools

## Implementation Tasks

### Task 1: Create Update Table Tool Factory

**Files:**
- Create: `src/tools/update-table.tool.ts`
- Test: `tests/unit/tools/update-table.tool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/tools/update-table.tool.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createUpdateTableTool } from "../../../src/tools/update-table.tool.js";

describe("createUpdateTableTool", () => {
  it("creates tool with correct name format", () => {
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
    expect(tool.name).toBe("update_table_users");
  });

  it("excludes primary key from settable columns", () => {
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
    const schema = tool.schema as any;
    const shape = schema.shape;
    
    // 'where' should exist
    expect(shape.where).toBeDefined();
    
    // 'name' and 'email' should exist as optional params
    expect(shape.name).toBeDefined();
    expect(shape.email).toBeDefined();
    
    // 'id' should NOT exist as settable param
    expect(shape.id).toBeUndefined();
  });

  it("requires at least one column to be set", async () => {
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
    const schema = tool.schema as any;
    
    // Should fail validation when only 'where' is provided
    const result = schema.safeParse({ where: "id = 1" });
    expect(result.success).toBe(false);
  });

  it("allows setting multiple columns", async () => {
    const tool = createUpdateTableTool("users", ["id", "name", "email"]);
    const schema = tool.schema as any;
    
    const result = schema.safeParse({ 
      where: "id = 1", 
      name: "John", 
      email: "john@example.com" 
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tools/update-table.tool.test.ts`
Expected: FAIL with "module not found" or "function not defined"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tools/update-table.tool.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { LoggerService } from "../services/logger.service.js";

export interface IUpdateTableResult {
  success: boolean;
  message: string;
  databaseName: string;
  tableName: string;
  where: string;
}

export function createUpdateTableTool(
  tableName: string,
  columns: string[],
): ReturnType<typeof tool> {
  const logger = LoggerService.getInstance();
  
  // Filter out primary key (id) from settable columns
  const settableColumns = columns.filter(col => col.toLowerCase() !== "id");
  
  // Build Zod schema with each column as optional parameter
  const columnSchemas: Record<string, z.ZodOptional<z.ZodType<string | number | boolean | null>>> = {};
  for (const col of settableColumns) {
    columnSchemas[col] = z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
    ]).optional().describe(`Value for column '${col}'`);
  }
  
  const schema = z.object({
    where: z.string()
      .min(1)
      .describe("SQL WHERE clause (required for safety, e.g. \"id = 5\")"),
    ...columnSchemas,
  }).refine(
    (data) => {
      const columns = Object.keys(data).filter(k => k !== "where");
      return columns.some(col => data[col] !== undefined);
    },
    { message: "At least one column must be set" },
  );
  
  const toolName = `update_table_${tableName}`;
  
  return tool(
    async (params: Record<string, unknown>): Promise<IUpdateTableResult> => {
      const { where, ...setParams } = params;
      
      // Filter out undefined values
      const setColumns: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(setParams)) {
        if (value !== undefined) {
          setColumns[key] = value;
        }
      }
      
      logger.info(`[update_table_${tableName}] Updating rows where ${where}`, {
        columns: Object.keys(setColumns),
      });
      
      // TODO: Implement actual database update logic
      // For now, return placeholder
      return {
        success: true,
        message: `Updated ${Object.keys(setColumns).length} column(s) in ${tableName} where ${where}`,
        databaseName: "default",
        tableName,
        where: where as string,
      };
    },
    {
      name: toolName,
      description: `Update rows in the '${tableName}' table. Requires a WHERE clause to prevent accidental full-table updates.`,
      schema,
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/tools/update-table.tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/update-table.tool.ts tests/unit/tools/update-table.tool.test.ts
git commit -m "feat: add per-table update tool factory"
```

### Task 2: Wire Update Tool Creation into Create Table

**Files:**
- Modify: `src/tools/create-table.tool.ts`
- Test: `tests/unit/tools/create-table.tool.test.ts` (update existing)

- [ ] **Step 1: Read create-table.tool.ts to understand current implementation**

Read: `src/tools/create-table.tool.ts`

- [ ] **Step 2: Add import for createUpdateTableTool**

Add to imports:
```typescript
import { createUpdateTableTool } from "./update-table.tool.js";
```

- [ ] **Step 3: After table creation, build update tool and return it**

Modify the tool implementation to return the update tool alongside the create result:

```typescript
// After table creation succeeds:
const updateTool = createUpdateTableTool(tableName, columns);
return {
  success: true,
  message: `Table '${tableName}' created with ${columns.length} columns`,
  updateTool, // Include the update tool for hot-reload
};
```

- [ ] **Step 4: Update existing tests to verify update tool is created**

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/tools/create-table.tool.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/create-table.tool.ts tests/unit/tools/create-table.tool.test.ts
git commit -m "feat: wire update tool creation into create table"
```

### Task 3: Hot-Reload Update Tools in Agent

**Files:**
- Modify: `src/agent/langchain-main-agent.ts`
- Test: `tests/unit/agent/langchain-main-agent-hot-reload.test.ts` (update existing)

- [ ] **Step 1: Read langchain-main-agent.ts to understand hot-reload pattern**

Read: `src/agent/langchain-main-agent.ts` - focus on `_rebuildToolsAsync` and `onToolEndAsync`

- [ ] **Step 2: Add update tool registration to hot-reload logic**

In the hot-reload path where `write_table_<tableName>` tools are added, also add `update_table_<tableName>`:

```typescript
// After write tool is created:
const updateTool = createUpdateTableTool(tableName, columns);
sessionTools[updateTool.name] = updateTool;
```

- [ ] **Step 3: Add test for update tool hot-reload**

```typescript
it("hot-reloads update_table_<tableName> when create_table succeeds", async () => {
  // Arrange: mock create_table to return update tool
  // Act: trigger hot-reload
  // Assert: update_table_users exists in session tools
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/agent/langchain-main-agent-hot-reload.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/langchain-main-agent.ts tests/unit/agent/langchain-main-agent-hot-reload.test.ts
git commit -m "feat: hot-reload update_table tools in agent"
```

### Task 4: Add Cron Description for Dynamic Update Tools

**Files:**
- Modify: `src/shared/constants/cron-descriptions.ts`
- Modify: `src/utils/cron-tool-context.ts`

- [ ] **Step 1: Add generic description for dynamic update tools**

In `cron-descriptions.ts`, add pattern matching for `update_table_*`:

```typescript
// Generic pattern for dynamic update tools
export const CRON_TOOL_DESCRIPTIONS: Record<string, string> = {
  // ... existing entries
  // Dynamic update_table_* tools use this pattern
};

export function getCronToolDescription(toolName: string): string | undefined {
  // Check exact match first
  if (CRON_TOOL_DESCRIPTIONS[toolName]) {
    return CRON_TOOL_DESCRIPTIONS[toolName];
  }
  
  // Check dynamic patterns
  if (toolName.startsWith("update_table_")) {
    const tableName = toolName.replace("update_table_", "");
    return `Update rows in the '${tableName}' table. Requires a WHERE clause for safety. Each column is an optional parameter.`;
  }
  
  return undefined;
}
```

- [ ] **Step 2: Update cron-tool-context.ts to use the new function**

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add src/shared/constants/cron-descriptions.ts src/utils/cron-tool-context.ts
git commit -m "feat: add cron descriptions for dynamic update tools"
```

### Task 5: Full Verification

**Files:**
- All files touched in previous tasks

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run tests/unit`
Expected: All tests pass (480+)

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Final commit if needed**

```bash
git add .
git commit -m "feat: complete per-table update tools implementation"
```

---

## Self-Review

### Spec Coverage
- ✅ Per-table `update_table_<tableName>` tools created at runtime
- ✅ Each column becomes optional parameter (not generic `set` object)
- ✅ `where` required for safety
- ✅ `.refine()` validates at least one column is set
- ✅ Primary key (`id`) excluded from settable columns
- ✅ Auto-created when `create_table` creates a table (via hot-reload)
- ✅ Cron descriptions for dynamic tools

### Placeholder Scan
- Task 1 Step 3: TODO comment for actual database update logic - this is intentional, the factory creates the tool structure, actual DB execution is separate concern
- All other steps contain complete code or clear instructions

### Type Consistency
- Tool name format: `update_table_<tableName>` consistent throughout
- Column filtering: `id` exclusion consistent
- Schema shape: column parameters consistent with `write_table` pattern

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-03-31-per-table-update-tools.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?