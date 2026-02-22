# Database Agent Tools Implementation Plan

**Goal:** Add `write_to_database` and `read_from_database` tools to the agent node tool pool, plus expose existing DB introspection tools (`list_databases`, `list_tables`, `get_table_schema`, `create_table`).

**Architecture:** The `read_from_database` tool requires a new `queryTableAsync` method on `LiteSqlService` since no public SELECT/query method exists. The `write_to_database` tool wraps existing `insertIntoTableAsync`. All 6 tools are stateless `const` exports following existing DB tool patterns, and get added to `_getAgentNodeToolPool()` in `JobExecutorService`.

**Design:** No formal design document — derived from `job-creation-guide.md` (lines 156-271) which already references these tools as available.

---

## Dependency Graph

```
Batch 1 (parallel): 1.1, 1.2        [foundation - new service method + new write tool]
Batch 2 (sequential): 2.1            [read tool - depends on 1.1 queryTableAsync]
Batch 3 (parallel): 3.1, 3.2, 3.3   [integration - barrel export, tool pool, docs]
```

---

## Batch 1: Foundation (parallel - 2 implementers)

All tasks in this batch have NO dependencies and run simultaneously.

### Task 1.1: Add `queryTableAsync` to LiteSqlService
**File:** `src/services/litesql.service.ts` (MODIFY)
**Test:** `tests/integration/litesql-service.test.ts` (MODIFY)
**Depends:** none

Add a new `IQueryResult` interface and `queryTableAsync` public method to `LiteSqlService`.

**Design decision:** The method accepts optional `where` (SQL WHERE clause), `orderBy`, `limit`, and `columns` parameters. It returns an array of row objects. This gives agents maximum flexibility while keeping the API simple. The WHERE clause is passed as a raw string since agents generate arbitrary conditions — parameterized queries aren't practical here since the agent doesn't know column types upfront.

**Test code** — append these tests to the existing `describe("LiteSqlService", ...)` block:

```typescript
// ADD to tests/integration/litesql-service.test.ts
// Append INSIDE the top-level describe("LiteSqlService", () => { ... }) block, after the tableExistsAsync describe block

  describe("queryTableAsync", () => {
    it("should return all rows when no filters specified", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "email", type: "TEXT" },
      ]);

      await service.insertIntoTableAsync("testdb", "users", [
        { id: 1, name: "Alice", email: "alice@test.com" },
        { id: 2, name: "Bob", email: "bob@test.com" },
        { id: 3, name: "Charlie", email: "charlie@test.com" },
      ]);

      const result: IQueryResult = await service.queryTableAsync("testdb", "users");

      expect(result.rows).toHaveLength(3);
      expect(result.totalCount).toBe(3);
      expect(result.rows[0]).toEqual({ id: 1, name: "Alice", email: "alice@test.com" });
    });

    it("should filter rows with where clause", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      await service.insertIntoTableAsync("testdb", "users", [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]);

      const result: IQueryResult = await service.queryTableAsync("testdb", "users", {
        where: "name = 'Alice'",
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({ id: 1, name: "Alice" });
    });

    it("should respect limit and orderBy", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "items", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "value", type: "INTEGER" },
      ]);

      await service.insertIntoTableAsync("testdb", "items", [
        { id: 1, value: 30 },
        { id: 2, value: 10 },
        { id: 3, value: 20 },
      ]);

      const result: IQueryResult = await service.queryTableAsync("testdb", "items", {
        orderBy: "value ASC",
        limit: 2,
      });

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ id: 2, value: 10 });
      expect(result.rows[1]).toEqual({ id: 3, value: 20 });
      expect(result.totalCount).toBe(3);
    });

    it("should select specific columns", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
        { name: "email", type: "TEXT" },
      ]);

      await service.insertIntoTableAsync("testdb", "users", { id: 1, name: "Alice", email: "alice@test.com" });

      const result: IQueryResult = await service.queryTableAsync("testdb", "users", {
        columns: ["name", "email"],
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({ name: "Alice", email: "alice@test.com" });
      expect(result.rows[0]).not.toHaveProperty("id");
    });

    it("should return empty array for no matching rows", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");
      await service.createTableAsync("testdb", "users", [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);

      const result: IQueryResult = await service.queryTableAsync("testdb", "users");

      expect(result.rows).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("should throw for non-existent database", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await expect(service.queryTableAsync("nonexistent", "users")).rejects.toThrow("does not exist");
    });

    it("should throw for non-existent table", async () => {
      const service: LiteSqlService = LiteSqlService.getInstance();

      await service.createDatabaseAsync("testdb");

      await expect(service.queryTableAsync("testdb", "nonexistent")).rejects.toThrow("does not exist");
    });
  });
```

**Important:** The test file also needs the `IQueryResult` import updated. Change the import at line 6:

```typescript
// MODIFY line 6 of tests/integration/litesql-service.test.ts
// Change:
import { LiteSqlService } from "../../src/services/litesql.service.js";
// To:
import { LiteSqlService, type IQueryResult } from "../../src/services/litesql.service.js";
```

**Implementation code** — add to `src/services/litesql.service.ts`:

1. Add `IQueryResult` interface after `IInsertResult` (around line 33):

```typescript
// ADD after line 35 (after IInsertResult interface closing brace)

export interface IQueryOptions {
  where?: string;
  orderBy?: string;
  limit?: number;
  columns?: string[];
}

export interface IQueryResult {
  rows: Record<string, unknown>[];
  totalCount: number;
}
```

2. Add `queryTableAsync` method inside the `Public methods` region, after `insertIntoTableAsync` (after line 275, before `databaseExistsAsync`):

```typescript
  // ADD after insertIntoTableAsync method, before databaseExistsAsync

  public async queryTableAsync(
    databaseName: string,
    tableName: string,
    options?: IQueryOptions,
  ): Promise<IQueryResult> {
    const db: Database.Database = this._openDatabase(databaseName);

    try {
      const tableExists: { count: number } = db
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tableName) as { count: number };

      if (tableExists.count === 0) {
        throw new Error(`Table "${tableName}" does not exist in database "${databaseName}"`);
      }

      const columnsPart: string = options?.columns?.length
        ? options.columns.map((c) => `"${c}"`).join(", ")
        : "*";

      let sql: string = `SELECT ${columnsPart} FROM "${tableName}"`;

      if (options?.where) {
        sql += ` WHERE ${options.where}`;
      }

      if (options?.orderBy) {
        sql += ` ORDER BY ${options.orderBy}`;
      }

      if (options?.limit !== undefined) {
        sql += ` LIMIT ${options.limit}`;
      }

      const rows: Record<string, unknown>[] = db
        .prepare(sql)
        .all() as Record<string, unknown>[];

      // Get total count (without limit) for pagination awareness
      let countSql: string = `SELECT COUNT(*) as count FROM "${tableName}"`;
      if (options?.where) {
        countSql += ` WHERE ${options.where}`;
      }

      const countResult: { count: number } = db
        .prepare(countSql)
        .get() as { count: number };

      this._logger.debug("Data queried", { databaseName, tableName, rowCount: rows.length });

      return {
        rows,
        totalCount: countResult.count,
      };
    } finally {
      db.close();
    }
  }
```

**Verify:** `pnpm vitest run tests/integration/litesql-service.test.ts --config vitest.integration.config.ts --reporter=verbose`
**Commit:** `feat(litesql): add queryTableAsync method for reading data from tables`

---

### Task 1.2: Create `write_to_database` tool
**File:** `src/tools/write-to-database.tool.ts` (CREATE)
**Test:** none (tool is a thin wrapper over tested `insertIntoTableAsync`)
**Depends:** none

```typescript
// CREATE src/tools/write-to-database.tool.ts
import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";

export const writeToDatabaseTool = tool({
  description: "Insert one or more rows into a database table. Each row is a JSON object whose keys match column names.",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database"),
    tableName: z.string()
      .min(1)
      .describe("Name of the table to insert into"),
    data: z.record(z.unknown())
      .or(
        z.record(z.unknown())
          .array()
          .min(1),
      )
      .describe("A single row object or array of row objects to insert. Keys must match column names."),
  }),
  execute: async ({
    databaseName,
    tableName,
    data,
  }: {
    databaseName: string;
    tableName: string;
    data: Record<string, unknown> | Record<string, unknown>[];
  }): Promise<{
    success: boolean;
    databaseName: string;
    tableName: string;
    insertedCount: number;
    lastRowId: number;
    message: string;
  }> => {
    const service: LiteSqlService = LiteSqlService.getInstance();

    const exists: boolean = await service.databaseExistsAsync(databaseName);
    if (!exists) {
      const allDbs = await service.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      throw new Error(
        `Database "${databaseName}" does not exist.\n` +
          `Available databases: ${available}`,
      );
    }

    const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const tables = await service.listTablesAsync(databaseName);
      const available: string = tables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${databaseName}".\n` +
          `Available tables: ${available}`,
      );
    }

    const result = await service.insertIntoTableAsync(databaseName, tableName, data);

    return {
      success: true,
      databaseName,
      tableName,
      insertedCount: result.insertedCount,
      lastRowId: result.lastRowId,
      message: `Inserted ${result.insertedCount} row(s) into "${tableName}"`,
    };
  },
});
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `feat(tools): add write_to_database tool for agent node database writes`

---

## Batch 2: Read Tool (1 implementer)

This task depends on Batch 1 (Task 1.1) completing.

### Task 2.1: Create `read_from_database` tool
**File:** `src/tools/read-from-database.tool.ts` (CREATE)
**Test:** none (tool is a thin wrapper over tested `queryTableAsync`)
**Depends:** 1.1 (imports `queryTableAsync` from `LiteSqlService`)

```typescript
// CREATE src/tools/read-from-database.tool.ts
import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService } from "../services/litesql.service.js";

export const readFromDatabaseTool = tool({
  description: "Query rows from a database table. Supports filtering with WHERE, ordering, limiting, and column selection.",
  inputSchema: z.object({
    databaseName: z.string()
      .min(1)
      .describe("Name of the database"),
    tableName: z.string()
      .min(1)
      .describe("Name of the table to query"),
    where: z.string()
      .optional()
      .describe("SQL WHERE clause (without the WHERE keyword). Example: \"name = 'Alice' AND age > 25\""),
    orderBy: z.string()
      .optional()
      .describe("SQL ORDER BY clause (without the ORDER BY keywords). Example: \"created_at DESC\""),
    limit: z.number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of rows to return"),
    columns: z.string()
      .array()
      .min(1)
      .optional()
      .describe("Specific columns to return. If omitted, all columns are returned."),
  }),
  execute: async ({
    databaseName,
    tableName,
    where,
    orderBy,
    limit,
    columns,
  }: {
    databaseName: string;
    tableName: string;
    where?: string;
    orderBy?: string;
    limit?: number;
    columns?: string[];
  }): Promise<{
    databaseName: string;
    tableName: string;
    rows: Record<string, unknown>[];
    rowCount: number;
    totalCount: number;
  }> => {
    const service: LiteSqlService = LiteSqlService.getInstance();

    const exists: boolean = await service.databaseExistsAsync(databaseName);
    if (!exists) {
      const allDbs = await service.listDatabasesAsync();
      const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

      throw new Error(
        `Database "${databaseName}" does not exist.\n` +
          `Available databases: ${available}`,
      );
    }

    const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName);
    if (!tableExists) {
      const tables = await service.listTablesAsync(databaseName);
      const available: string = tables.join(", ") || "(none)";

      throw new Error(
        `Table "${tableName}" does not exist in database "${databaseName}".\n` +
          `Available tables: ${available}`,
      );
    }

    const result = await service.queryTableAsync(databaseName, tableName, {
      where,
      orderBy,
      limit,
      columns,
    });

    return {
      databaseName,
      tableName,
      rows: result.rows,
      rowCount: result.rows.length,
      totalCount: result.totalCount,
    };
  },
});
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `feat(tools): add read_from_database tool for agent node database queries`

---

## Batch 3: Integration (parallel - 3 implementers)

All tasks depend on Batches 1-2 completing.

### Task 3.1: Update barrel exports in `src/tools/index.ts`
**File:** `src/tools/index.ts` (MODIFY)
**Test:** none (barrel export, verified by typecheck)
**Depends:** 1.2, 2.1

Add two new export lines after the existing `dropTableTool` export (currently line 41). Insert these two lines after `export { dropTableTool } from "./drop-table.tool.js";`:

```typescript
// ADD after line 41 (after dropTableTool export)
export { writeToDatabaseTool } from "./write-to-database.tool.js";
export { readFromDatabaseTool } from "./read-from-database.tool.js";
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `feat(tools): export write and read database tools from barrel`

---

### Task 3.2: Add DB tools to agent node tool pool
**File:** `src/services/job-executor.service.ts` (MODIFY)
**Test:** none (integration tested via existing job-execution-e2e tests + typecheck)
**Depends:** 3.1

Two modifications needed:

**1. Update the import** at lines 41-53. Change:

```typescript
// FIND this import block (lines 41-53):
import {
  thinkTool,
  runCmdTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  FileReadTracker,
} from "../tools/index.js";
```

Replace with:

```typescript
import {
  thinkTool,
  runCmdTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  FileReadTracker,
  writeToDatabaseTool,
  readFromDatabaseTool,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  createTableTool,
} from "../tools/index.js";
```

**2. Update `_getAgentNodeToolPool()`** (lines 807-818). Change the return statement from:

```typescript
    return {
      think: thinkTool,
      run_cmd: runCmdTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(logSender),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
    };
```

To:

```typescript
    return {
      think: thinkTool,
      run_cmd: runCmdTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(logSender),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
      write_to_database: writeToDatabaseTool,
      read_from_database: readFromDatabaseTool,
      list_databases: listDatabasesTool,
      list_tables: listTablesTool,
      get_table_schema: getTableSchemaTool,
      create_table: createTableTool,
    };
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `feat(executor): add 6 database tools to agent node tool pool`

---

### Task 3.3: Update agent-node-guide.md tool table
**File:** `src/defaults/prompts/agent-node-guide.md` (MODIFY)
**Test:** none (documentation)
**Depends:** 3.2 (must match actual tool pool)

Add 6 new rows to the tool table at lines 112-124. Find this block:

```markdown
| `append_file` | Append content to a file |
| `edit_file` | Edit a file in place |
```

And add after it:

```markdown
| `write_to_database` | Insert rows into a database table |
| `read_from_database` | Query rows from a database table with optional filtering |
| `list_databases` | List all available databases |
| `list_tables` | List all tables in a database |
| `get_table_schema` | Get column definitions of a table |
| `create_table` | Create a new table in a database |
```

**Verify:** Visual inspection — 16 tool rows total (10 existing + 6 new).
**Commit:** `docs(agent-node): add database tools to available tools table`
