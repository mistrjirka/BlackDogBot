# Remove Manual Node Type & Add Job Schedule Tools

**Goal:** Remove the redundant `manual` node type (identical to `start`), add `IStartNodeConfig` with an optional `scheduledTaskId` back-reference, and create `set_job_schedule`/`remove_job_schedule` tools that auto-manage ScheduledTasks linked to jobs.

**Architecture:** The `manual` node is removed from every type/schema/tool/test that references it. The `start` node gains an `IStartNodeConfig` interface with an optional `scheduledTaskId`. Two new tools (`set_job_schedule`, `remove_job_schedule`) find a job's start node, manage the linked ScheduledTask via `SchedulerService`, and update the start node's config. The schedule data itself lives on the `IScheduledTask` (no duplication).

---

## Dependency Graph

```
Batch 1 (parallel): 1.1, 1.2, 1.3, 1.4 [types, schemas, tool-schemas — no deps]
Batch 2 (parallel): 2.1, 2.2, 2.3, 2.4, 2.5 [tools & services that import batch 1]
Batch 3 (parallel): 3.1, 3.2, 3.3, 3.4, 3.5 [integration: main-agent, barrel, brain-interface, guides]
Batch 4 (parallel): 4.1, 4.2, 4.3, 4.4, 4.5 [test file fixes]
```

---

## Batch 1: Foundation (parallel — 4 implementers)

All tasks in this batch have NO dependencies and run simultaneously.

### Task 1.1: Update job types — remove `manual`, add `IStartNodeConfig`
**File:** `src/shared/types/job.types.ts`
**Test:** none (type-only changes verified by typecheck)
**Depends:** none

The `NodeType` union must lose `"manual"`. A new `IStartNodeConfig` interface must be added. `NodeConfig` union must include it.

```typescript
// In src/shared/types/job.types.ts

// CHANGE 1: Remove "manual" from NodeType
// Old:
//   export type NodeType =
//     | "start"
//     | "manual"
//     | "curl_fetcher"
//     ...
// New:
export type NodeType =
  | "start"
  | "curl_fetcher"
  | "crawl4ai"
  | "searxng"
  | "rss_fetcher"
  | "python_code"
  | "output_to_ai"
  | "agent"
  | "litesql";

// CHANGE 2: Add IStartNodeConfig after ILiteSqlConfig
export interface IStartNodeConfig {
  scheduledTaskId: string | null;
}

// CHANGE 3: Add IStartNodeConfig to NodeConfig union
// Old:
//   export type NodeConfig =
//     | IAgentNodeConfig
//     | ICurlFetcherConfig
//     ...
//     | ILiteSqlConfig
//     | Record<string, never>;
// New:
export type NodeConfig =
  | IAgentNodeConfig
  | ICurlFetcherConfig
  | ICrawl4AiConfig
  | ISearxngConfig
  | IRssFetcherConfig
  | IPythonCodeConfig
  | IOutputToAiConfig
  | ILiteSqlConfig
  | IStartNodeConfig
  | Record<string, never>;
```

**Verify:** `pnpm typecheck` (will have errors until batch 2 completes — that's expected)
**Commit:** `refactor(types): remove manual node type, add IStartNodeConfig`

---

### Task 1.2: Update job schemas — remove `manual` from `nodeTypeSchema`, add `startNodeConfigSchema`
**File:** `src/shared/schemas/job.schemas.ts`
**Test:** none (schema changes verified by typecheck)
**Depends:** none

```typescript
// In src/shared/schemas/job.schemas.ts

// CHANGE 1: Remove "manual" from nodeTypeSchema
// Old:
//   export const nodeTypeSchema = z.enum([
//     "manual",
//     "curl_fetcher",
//     ...
//   ]);
// New:
export const nodeTypeSchema = z.enum([
  "curl_fetcher",
  "crawl4ai",
  "searxng",
  "rss_fetcher",
  "python_code",
  "output_to_ai",
  "agent",
  "litesql",
]);

// CHANGE 2: Add startNodeConfigSchema after liteSqlConfigSchema
export const startNodeConfigSchema = z.object({
  scheduledTaskId: z.string()
    .nullable()
    .default(null)
    .describe("ID of the auto-created ScheduledTask linked to this job (null = manual-only)"),
});

// CHANGE 3: Add startNodeConfigSchema to nodeConfigSchema union
// Old:
//   export const nodeConfigSchema = z.union([
//     agentNodeConfigSchema,
//     ...
//     liteSqlConfigSchema,
//     z.object({}).strict(),
//   ]);
// New:
export const nodeConfigSchema = z.union([
  agentNodeConfigSchema,
  curlFetcherConfigSchema,
  crawl4AiConfigSchema,
  searxngConfigSchema,
  rssFetcherConfigSchema,
  pythonCodeConfigSchema,
  outputToAiConfigSchema,
  liteSqlConfigSchema,
  startNodeConfigSchema,
  z.object({}).strict(),
]);
```

Note: `nodeTypeSchema` does NOT include `"start"` currently — it was only used for add_node tool input validation. The `"start"` type is created automatically by `start_job_creation`. This is correct and unchanged.

**Verify:** `pnpm typecheck`
**Commit:** `refactor(schemas): remove manual from nodeTypeSchema, add startNodeConfigSchema`

---

### Task 1.3: Update tool-schemas — remove `manual` from `addNodeToolInputSchema` type enum, remove manual node tool schemas, add schedule tool schemas
**File:** `src/shared/schemas/tool-schemas.ts`
**Test:** none (schema changes verified by typecheck)
**Depends:** none

```typescript
// In src/shared/schemas/tool-schemas.ts

// CHANGE 1: Remove "manual" from addNodeToolInputSchema type enum
// Old:
//   type: z.enum(["start", "manual", "curl_fetcher", "crawl4ai", "searxng", "rss_fetcher", "python_code", "output_to_ai", "agent", "litesql"]),
// New:
//   type: z.enum(["start", "curl_fetcher", "crawl4ai", "searxng", "rss_fetcher", "python_code", "output_to_ai", "agent", "litesql"]),

// CHANGE 2: Remove addManualNodeToolInputSchema and addManualNodeToolOutputSchema
// Delete these two exports entirely:
//   export const addManualNodeToolInputSchema = z.object({
//     ..._commonNodeCreationFields,
//   });
//
//   export const addManualNodeToolOutputSchema = z.object({
//     nodeId: z.string(),
//     success: z.boolean(),
//     message: z.string(),
//   });

// CHANGE 3: Add set_job_schedule and remove_job_schedule tool schemas
// Add at the end of the //#region Cron Tools section (before //#endregion Cron Tools)

import { scheduleSchema } from "./cron.schemas.js";

// NOTE: The import above needs to be added at the top of the file with the
// other imports. Currently only `z` is imported.

export const setJobScheduleToolInputSchema = z.object({
  jobId: z.string()
    .min(1)
    .describe("ID of the job to schedule"),
  schedule: z.object({
    type: z.enum(["once", "interval", "cron"]),
    runAt: z.string()
      .optional(),
    intervalMs: z.number()
      .optional(),
    expression: z.string()
      .optional(),
  })
    .describe("Schedule configuration (same format as add_cron)"),
});

export const setJobScheduleToolOutputSchema = z.object({
  success: z.boolean(),
  scheduledTaskId: z.string()
    .describe("ID of the created/updated ScheduledTask"),
  message: z.string(),
});

export const removeJobScheduleToolInputSchema = z.object({
  jobId: z.string()
    .min(1)
    .describe("ID of the job whose schedule to remove"),
});

export const removeJobScheduleToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});
```

**Verify:** `pnpm typecheck`
**Commit:** `feat(schemas): add set/remove job schedule tool schemas, remove manual node schemas`

---

### Task 1.4: Update brain-interface types — remove `manual` from `NodeType`
**File:** `brain-interface/src/app/models/brain.types.ts`
**Test:** none (type-only — verified by build)
**Depends:** none

```typescript
// In brain-interface/src/app/models/brain.types.ts

// CHANGE: Remove "manual" from NodeType union
// Old:
//   export type NodeType =
//     | "start"
//     | "manual"
//     | "curl_fetcher"
//     ...
// New:
export type NodeType =
  | "start"
  | "curl_fetcher"
  | "crawl4ai"
  | "searxng"
  | "rss_fetcher"
  | "python_code"
  | "output_to_ai"
  | "agent"
  | "litesql";
```

**Verify:** Brain interface typecheck (if available) or just verify no TS errors in the file
**Commit:** `refactor(brain-interface): remove manual from NodeType`

---

## Batch 2: Core Modules (parallel — 5 implementers)

All tasks in this batch depend on Batch 1 completing.

### Task 2.1: Update job executor — remove `manual` case
**File:** `src/services/job-executor.service.ts`
**Test:** none (existing tests will be updated in Batch 4)
**Depends:** 1.1

```typescript
// In src/services/job-executor.service.ts

// CHANGE: Remove the "manual" case from the switch statement in _executeNodeAsync
// Around line 303-304, remove:
//
//       case "manual":
//         return input;
//
// The "start" case already handles passthrough (line 300-301).
// The "default" case will now catch any remaining unknown types.
```

**Verify:** `pnpm typecheck`
**Commit:** `refactor(executor): remove manual node case from executor switch`

---

### Task 2.2: Update job storage — remove `manual` from test case guard
**File:** `src/services/job-storage.service.ts`
**Test:** none (pure edit — tests updated in batch 4)
**Depends:** 1.1

```typescript
// In src/services/job-storage.service.ts

// CHANGE: In addTestCaseAsync, remove "manual" from the guard condition
// Line 274: 
// Old:
//     if (node && (node.type === "start" || node.type === "manual")) {
//       throw new Error("Test cases cannot be created for start or manual nodes — they are passthroughs with no logic to test.");
//     }
// New:
//     if (node && node.type === "start") {
//       throw new Error("Test cases cannot be created for start nodes — they are passthroughs with no logic to test.");
//     }
```

**Verify:** `pnpm typecheck`
**Commit:** `refactor(storage): remove manual node reference from test case guard`

---

### Task 2.3: Delete add-manual-node.tool.ts
**File:** `src/tools/add-manual-node.tool.ts`
**Test:** none
**Depends:** 1.3

Delete the file entirely. The barrel export and main-agent registration will be cleaned up in Batch 3.

```bash
# Delete the file
rm src/tools/add-manual-node.tool.ts
```

**Verify:** File no longer exists
**Commit:** `refactor(tools): delete add-manual-node.tool.ts`

---

### Task 2.4: Create set-job-schedule.tool.ts
**File:** `src/tools/set-job-schedule.tool.ts`
**Test:** none (integration tool — tested via typecheck and manual verification)
**Depends:** 1.1, 1.3

```typescript
import { tool } from "ai";
import { setJobScheduleToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { generateId } from "../utils/id.js";
import type { IJob, INode, IStartNodeConfig } from "../shared/types/index.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

interface ISetJobScheduleResult {
  success: boolean;
  scheduledTaskId: string;
  message: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "set_job_schedule";

const TOOL_DESCRIPTION: string =
  "Set or update a schedule on a job. Creates a ScheduledTask that will automatically " +
  "run the job on the given schedule. If the job already has a schedule, the old one is " +
  "replaced. The schedule uses the same format as add_cron (type: 'once'/'interval'/'cron').";

//#endregion Const

//#region Private methods

function _buildSchedule(input: {
  type: "once" | "interval" | "cron";
  runAt?: string;
  intervalMs?: number;
  expression?: string;
}): Schedule {
  switch (input.type) {
    case "once":
      return { type: "once", runAt: input.runAt! };
    case "interval":
      return { type: "interval", intervalMs: input.intervalMs! };
    case "cron":
      return { type: "cron", expression: input.expression! };
  }
}

//#endregion Private methods

//#region Tool

export const setJobScheduleTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: setJobScheduleToolInputSchema,
  execute: async ({
    jobId,
    schedule,
  }: {
    jobId: string;
    schedule: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string };
  }): Promise<ISetJobScheduleResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const schedulerService: SchedulerService = SchedulerService.getInstance();

      // 1. Find the job
      const job: IJob | null = await storageService.getJobAsync(jobId);

      if (!job) {
        return { success: false, scheduledTaskId: "", message: `Job "${jobId}" not found.` };
      }

      if (!job.entrypointNodeId) {
        return { success: false, scheduledTaskId: "", message: `Job "${jobId}" has no entrypoint node.` };
      }

      // 2. Find the start node
      const startNode: INode | null = await storageService.getNodeAsync(jobId, job.entrypointNodeId);

      if (!startNode || startNode.type !== "start") {
        return { success: false, scheduledTaskId: "", message: `Job "${jobId}" entrypoint is not a start node.` };
      }

      // 3. If start node already has a scheduledTaskId, remove the old ScheduledTask
      const existingConfig: IStartNodeConfig = startNode.config as IStartNodeConfig;
      const existingTaskId: string | null = existingConfig?.scheduledTaskId ?? null;

      if (existingTaskId) {
        try {
          await schedulerService.removeTaskAsync(existingTaskId);
        } catch {
          // Old task may already be gone — continue
        }
      }

      // 4. Create a new ScheduledTask
      const taskId: string = generateId();
      const now: string = new Date().toISOString();
      const builtSchedule: Schedule = _buildSchedule(schedule);

      const task: IScheduledTask = {
        taskId,
        name: `Job: ${job.name}`,
        description: `Auto-scheduled task for job "${job.name}" (${jobId})`,
        instructions: `Run job ${jobId} titled '${job.name}'. Use the run_job tool with jobId="${jobId}".`,
        tools: ["run_job"],
        schedule: builtSchedule,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
      };

      await schedulerService.addTaskAsync(task);

      // 5. Update start node config with scheduledTaskId
      const updatedConfig: IStartNodeConfig = { scheduledTaskId: taskId };
      await storageService.updateNodeAsync(jobId, startNode.nodeId, { config: updatedConfig });

      logger.info(`[${TOOL_NAME}] Schedule set for job "${job.name}"`, { jobId, taskId });

      return {
        success: true,
        scheduledTaskId: taskId,
        message: `Schedule set for job "${job.name}". ScheduledTask "${taskId}" created with ${schedule.type} schedule.`,
      };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      logger.error(`[${TOOL_NAME}] Failed: ${errorMessage}`);

      return { success: false, scheduledTaskId: "", message: errorMessage };
    }
  },
});

//#endregion Tool
```

**Verify:** `pnpm typecheck`
**Commit:** `feat(tools): add set_job_schedule tool`

---

### Task 2.5: Create remove-job-schedule.tool.ts
**File:** `src/tools/remove-job-schedule.tool.ts`
**Test:** none (integration tool — tested via typecheck and manual verification)
**Depends:** 1.1, 1.3

```typescript
import { tool } from "ai";
import { removeJobScheduleToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import type { IJob, INode, IStartNodeConfig } from "../shared/types/index.js";

//#region Interfaces

interface IRemoveJobScheduleResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "remove_job_schedule";

const TOOL_DESCRIPTION: string =
  "Remove the schedule from a job. Deletes the linked ScheduledTask and clears the " +
  "start node's scheduledTaskId. The job will no longer run automatically.";

//#endregion Const

//#region Tool

export const removeJobScheduleTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: removeJobScheduleToolInputSchema,
  execute: async ({
    jobId,
  }: {
    jobId: string;
  }): Promise<IRemoveJobScheduleResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const schedulerService: SchedulerService = SchedulerService.getInstance();

      // 1. Find the job
      const job: IJob | null = await storageService.getJobAsync(jobId);

      if (!job) {
        return { success: false, message: `Job "${jobId}" not found.` };
      }

      if (!job.entrypointNodeId) {
        return { success: false, message: `Job "${jobId}" has no entrypoint node.` };
      }

      // 2. Find the start node
      const startNode: INode | null = await storageService.getNodeAsync(jobId, job.entrypointNodeId);

      if (!startNode || startNode.type !== "start") {
        return { success: false, message: `Job "${jobId}" entrypoint is not a start node.` };
      }

      // 3. Check if start node has a scheduledTaskId
      const existingConfig: IStartNodeConfig = startNode.config as IStartNodeConfig;
      const existingTaskId: string | null = existingConfig?.scheduledTaskId ?? null;

      if (!existingTaskId) {
        return { success: false, message: `Job "${job.name}" has no schedule to remove.` };
      }

      // 4. Remove the ScheduledTask
      try {
        await schedulerService.removeTaskAsync(existingTaskId);
      } catch {
        // Task may already be gone — continue with config cleanup
      }

      // 5. Clear the start node config
      const updatedConfig: IStartNodeConfig = { scheduledTaskId: null };
      await storageService.updateNodeAsync(jobId, startNode.nodeId, { config: updatedConfig });

      logger.info(`[${TOOL_NAME}] Schedule removed from job "${job.name}"`, { jobId });

      return {
        success: true,
        message: `Schedule removed from job "${job.name}". ScheduledTask "${existingTaskId}" deleted.`,
      };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      logger.error(`[${TOOL_NAME}] Failed: ${errorMessage}`);

      return { success: false, message: errorMessage };
    }
  },
});

//#endregion Tool
```

**Verify:** `pnpm typecheck`
**Commit:** `feat(tools): add remove_job_schedule tool`

---

## Batch 3: Integration (parallel — 5 implementers)

All tasks in this batch depend on Batch 2 completing.

### Task 3.1: Update tools/index.ts — remove manual export, add schedule tool exports
**File:** `src/tools/index.ts`
**Test:** none (barrel file)
**Depends:** 2.3, 2.4, 2.5

```typescript
// In src/tools/index.ts

// CHANGE 1: Remove the manual node tool export line
// Delete this line:
//   export { createAddManualNodeTool } from "./add-manual-node.tool.js";

// CHANGE 2: Add the new schedule tool exports
// After the line: export { listCronsTool } from "./list-crons.tool.js";
// Add:
export { setJobScheduleTool } from "./set-job-schedule.tool.js";
export { removeJobScheduleTool } from "./remove-job-schedule.tool.js";
```

**Verify:** `pnpm typecheck`
**Commit:** `refactor(tools): update barrel exports — remove manual, add schedule tools`

---

### Task 3.2: Update main-agent.ts — remove manual tool, add schedule tools
**File:** `src/agent/main-agent.ts`
**Test:** none (integration — verified by typecheck)
**Depends:** 2.3, 2.4, 2.5, 3.1

```typescript
// In src/agent/main-agent.ts

// CHANGE 1: In the import block, remove `createAddManualNodeTool` from the
// destructured import from "../tools/index.js"
// And add `setJobScheduleTool` and `removeJobScheduleTool`

// CHANGE 2: In the _GraphMutatingTools Set, remove:
//   "add_manual_node",

// CHANGE 3: In the `nodeCreationTools` object inside `initializeForChatAsync`,
// remove:
//   add_manual_node: createAddManualNodeTool(jobTracker),

// CHANGE 4: In the `tools` object, add the schedule tools:
//   set_job_schedule: setJobScheduleTool,
//   remove_job_schedule: removeJobScheduleTool,
// (Add these alongside the other cron tools, after `list_crons: listCronsTool,`)
```

Specific edits:

In the import block, find `createAddManualNodeTool,` and remove it. Add `setJobScheduleTool,` and `removeJobScheduleTool,` to the import.

In `_GraphMutatingTools`, remove the `"add_manual_node",` entry.

In the `nodeCreationTools` object, remove:
```typescript
      add_manual_node: createAddManualNodeTool(jobTracker),
```

In the `tools` object, after `list_crons: listCronsTool,` add:
```typescript
      set_job_schedule: setJobScheduleTool,
      remove_job_schedule: removeJobScheduleTool,
```

**Verify:** `pnpm typecheck`
**Commit:** `feat(agent): register schedule tools, remove manual node tool`

---

### Task 3.3: Update job-creation-guide.md — remove manual references, add scheduling docs
**File:** `src/defaults/prompts/job-creation-guide.md`
**Test:** none (documentation)
**Depends:** none (documentation can be done anytime, but logically depends on the feature being defined)

```markdown
// CHANGE 1: In the <task> section, step 4, change:
// Old:
//   4. **Add tests** — for each node **except `start` and `manual` nodes** (which are passthroughs with no logic), add at least one test with `add_node_test` and run it with `run_node_test` to verify behavior.
// New:
//   4. **Add tests** — for each node **except `start` nodes** (which are passthroughs with no logic), add at least one test with `add_node_test` and run it with `run_node_test` to verify behavior.

// CHANGE 2: In <design_principles>, remove the bullet about manual node:
// Delete:
//   - The `manual` node is a pass-through — it does nothing to the data. Use it
//     as an entrypoint to accept external input into the graph.

// CHANGE 3: In <node_types>, remove the entire `## manual` section:
// Delete from "## manual" through "**Output:** Identical to input." and the "---" separator.

// CHANGE 4: Add a new section after </editing_after_creation> and before the
// closing of the file, for scheduling:
```

Add this section at the end of the file (before the closing markdown):

```markdown
<job_scheduling>
## Scheduling jobs to run automatically

After creating a job, you can attach a schedule so it runs automatically:

1. **Set a schedule** — call `set_job_schedule` with the `jobId` and a `schedule`
   object. This creates a ScheduledTask that will run the job automatically.
   The schedule format is the same as `add_cron`:
   - `{ type: "cron", expression: "0 9 * * *" }` — daily at 09:00
   - `{ type: "interval", intervalMs: 3600000 }` — every hour
   - `{ type: "once", runAt: "2026-03-01T00:00:00Z" }` — one-time

2. **Update a schedule** — call `set_job_schedule` again with a new schedule.
   The old ScheduledTask is automatically removed and replaced.

3. **Remove a schedule** — call `remove_job_schedule` with the `jobId` to
   stop automatic execution. The job can still be run manually with `run_job`.

**Example workflow:**
```
start_job_creation(name="Daily RSS Digest", ...)
add_rss_fetcher_node(...)
add_output_to_ai_node(...)
finish_job_creation(jobId)
set_job_schedule(jobId, { type: "cron", expression: "0 8 * * *" })
```

**Note:** `set_job_schedule` is preferred over `add_cron` for job scheduling
because it links the schedule to the job's start node, making it easy to
update or remove later. Use `add_cron` only for general-purpose scheduled
tasks that are not tied to a specific job.
</job_scheduling>
```

**Verify:** Read the file and confirm it renders correctly
**Commit:** `docs(guide): remove manual node docs, add job scheduling section`

---

### Task 3.4: Update main-agent.md — mention schedule tools in capabilities
**File:** `src/defaults/prompts/main-agent.md`
**Test:** none (documentation)
**Depends:** none

```markdown
// CHANGE 1: In <job_creation> section, add a step about scheduling after step 3:
// After:
//   3. Use `finish_job_creation` to validate the graph, run tests, mark the job as ready, and exit creation mode.
// Add:
//   4. Optionally, call `set_job_schedule` to attach a recurring or one-time schedule to the job.

// CHANGE 2: In <capabilities>, add:
//   - Schedule jobs to run automatically with set_job_schedule / remove_job_schedule.
// (After the line about scheduled tasks)
```

**Verify:** Read the file and confirm changes
**Commit:** `docs(prompt): add schedule tool references to main-agent prompt`

---

### Task 3.5: Update start-job-creation.tool.ts — pass `IStartNodeConfig` as initial config
**File:** `src/tools/start-job-creation.tool.ts`
**Test:** none (integration tool)
**Depends:** 1.1

```typescript
// In src/tools/start-job-creation.tool.ts

// CHANGE: When creating the start node, pass IStartNodeConfig as the config
// instead of empty object.
//
// Old (line ~56):
//         const startNode: INode = await storageService.addNodeAsync(
//           job.jobId,
//           "start",
//           "Start",
//           startNodeDescription,
//           {},
//           {},
//           {},
//         );
//
// New:
//         const startNode: INode = await storageService.addNodeAsync(
//           job.jobId,
//           "start",
//           "Start",
//           startNodeDescription,
//           {},
//           {},
//           { scheduledTaskId: null },
//         );

// Also add the import for IStartNodeConfig:
// Old import:
//   import { IJob, INode } from "../shared/types/index.js";
// New import:
//   import { IJob, INode, IStartNodeConfig } from "../shared/types/index.js";
```

Note: Importing `IStartNodeConfig` is optional since we're using an object literal, but it's good practice for documentation. The cast is not needed since `{ scheduledTaskId: null }` matches `IStartNodeConfig` structurally and is assignable to `NodeConfig`.

**Verify:** `pnpm typecheck`
**Commit:** `feat(tools): pass IStartNodeConfig when creating start node`

---

## Batch 4: Test File Fixes (parallel — 5 implementers)

All tasks in this batch depend on Batch 2 completing. These fix existing tests that reference `"manual"`.

### Task 4.1: Update job-execution-e2e.test.ts — replace `manual` with `start`
**File:** `tests/integration/job-execution-e2e.test.ts`
**Test:** self (this IS the test file)
**Depends:** 2.1, 2.2

Replace all occurrences of the string `"manual"` used as a node type with `"start"`.

Specific lines to change (based on grep results):
- Line 111: `"manual"` → `"start"`
- Line 150: `job.jobId, "manual", "Node A"` → `job.jobId, "start", "Node A"`
- Line 154: `job.jobId, "manual", "Node B"` → `job.jobId, "start", "Node B"`
- Line 264: `job.jobId, "manual", "Input Node"` → `job.jobId, "start", "Input Node"`
- Line 328: `job.jobId, "manual", "Strict Node"` → `job.jobId, "start", "Strict Node"`
- Line 1284: `job.jobId, "manual", "Input Node"` → `job.jobId, "start", "Input Node"`
- Line 1436: `"manual"` → `"start"`
- Line 1496: `"manual"` → `"start"`

Use `replaceAll` to change all `"manual"` to `"start"` ONLY where it refers to node type. Read the file first and be careful to only change node type references, not string content like `"manual"` in descriptions or other contexts.

**Verify:** `pnpm vitest run tests/integration/job-execution-e2e.test.ts --config vitest.integration.config.ts --reporter=verbose`
**Commit:** `test: replace manual node type with start in job execution tests`

---

### Task 4.2: Update ascii-graph.test.ts — replace `manual` with `start`
**File:** `tests/integration/ascii-graph.test.ts`
**Test:** self
**Depends:** 1.1

Lines to change (based on grep):
- Line 12: `type: "manual"` → `type: "start"`
- Line 38: `type: "manual"` → `type: "start"`
- Line 54: `type: "manual"` → `type: "start"`
- Line 176: `type: "manual"` → `type: "start"`
- Line 178: `type: "manual"` → `type: "start"`
- Line 216: `type: "manual"` → `type: "start"`
- Line 217: `type: "manual"` → `type: "start"`

Also check line 43: `expect(result).toContain("manual")` → `expect(result).toContain("start")`
And line 52: `type: "manual"` → `type: "start"`
And line 34: `type: "manual"` → check if name has "Manual" in it

Use `replaceAll` to replace `"manual"` → `"start"` for type fields. For names like `"My Manual Node"`, change to `"My Start Node"` or just `"My Node"`.

**Verify:** `pnpm vitest run tests/integration/ascii-graph.test.ts --config vitest.integration.config.ts --reporter=verbose`
**Commit:** `test: replace manual node type with start in ascii graph tests`

---

### Task 4.3: Update graph.test.ts — replace `manual` with `start`
**File:** `tests/integration/graph.test.ts`
**Test:** self
**Depends:** 1.1

Line to change:
- Line 16: `type: "manual"` → `type: "start"`

**Verify:** `pnpm vitest run tests/integration/graph.test.ts --config vitest.integration.config.ts --reporter=verbose`
**Commit:** `test: replace manual node type with start in graph tests`

---

### Task 4.4: Update execution-progress.test.ts — replace `manual` with `start`
**File:** `tests/integration/execution-progress.test.ts`
**Test:** self
**Depends:** 1.1

Line to change:
- Line 68: `"manual"` → `"start"`

**Verify:** `pnpm vitest run tests/integration/execution-progress.test.ts --config vitest.integration.config.ts --reporter=verbose`
**Commit:** `test: replace manual node type with start in execution progress tests`

---

### Task 4.5: Update graph-renderer.test.ts — replace `manual` with `start`
**File:** `tests/integration/graph-renderer.test.ts`
**Test:** self
**Depends:** 1.1

Lines to change:
- Line 12: `type: "manual"` → `type: "start"`
- Line 34: `type: "manual"` → `type: "start"` (also update name if it says "My Manual Node")
- Line 43: `expect(result).toContain("manual")` → `expect(result).toContain("start")`
- Line 52: `type: "manual"` → `type: "start"`

**Verify:** `pnpm vitest run tests/integration/graph-renderer.test.ts --config vitest.integration.config.ts --reporter=verbose`
**Commit:** `test: replace manual node type with start in graph renderer tests`

---

## Post-Implementation Notes

### Files NOT changed (and why):
- `src/tools/add-node.tool.ts` — The `addNodeToolInputSchema` (which references the enum) is updated in Task 1.3. The tool itself doesn't hardcode `"manual"`, so no further changes needed.
- `src/tools/add-cron.tool.ts` — Unchanged. It's the general-purpose cron tool. `set_job_schedule` is the job-specific wrapper.
- `src/shared/schemas/index.ts` — No change needed. It re-exports everything from `job.schemas.ts` and `tool-schemas.ts`.
- `src/shared/types/index.ts` — No change needed. It re-exports everything from `job.types.ts`.
- `README.md` — Should be updated to remove `manual` from the node types table and mention `set_job_schedule`/`remove_job_schedule`. This is a documentation-only change that can be done separately.

### Important implementation decisions:
1. **`IStartNodeConfig` uses `scheduledTaskId: string | null`** — `null` means manual-only (no auto-schedule). This matches the design's back-reference pattern.
2. **Schedule data lives on `IScheduledTask`, NOT on the start node** — avoids data duplication. The start node only stores the link.
3. **`set_job_schedule` is a standalone tool (not a factory function)** — it doesn't need `jobTracker` or `creationModeTracker` because it accesses services via singletons (same pattern as `addCronTool`).
4. **`set_job_schedule` is always available (not mode-gated)** — schedule can be set before or after job creation mode.
5. **Tests use `"start"` instead of `"manual"`** — since both were passthrough, tests keep working with just a type rename.
