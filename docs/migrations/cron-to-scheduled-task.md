# Cron to Scheduled Task Migration Plan

## Overview

Migrate blackdogbotmain's cron system to a unified "scheduled task" model with interval-based scheduling, removing all cron expression complexity.

---

## What Changes

### Before
- Schedule types: `cron` (raw expression), `interval` (ms), `once` (datetime)
- External dependency: `croner` for expression parsing
- Complex schema with multiple types

### After
- Single schedule type: `scheduled` with:
  - `intervalMinutes: number` - required, how often
  - `startHour: number | null` - optional, for daily at specific time
  - `startMinute: number | null` - optional, for daily at specific time
  - `runOnce: boolean` - optional, default false
- No external dependencies for scheduling
- Simple interval math only

---

## Phase 1: Type & Schema Changes

### 1.1 Types (`src/shared/types/cron.types.ts`)

**Current:**
```typescript
type ScheduleType = "once" | "interval" | "cron";

interface IScheduleCron {
  type: "cron";
  expression: string;
}

interface IScheduleInterval {
  type: "interval";
  intervalMs: number;
}

interface IScheduleOnce {
  type: "once";
  runAt: string;
}
```

**New:**
```typescript
interface IScheduledTask {
  taskId: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  schedule: IScheduleScheduled;
  notifyUser: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: "success" | "failure" | null;
  lastRunError: string | null;
  messageHistory: unknown[];
  messageSummary: string | null;
  summaryGeneratedAt: string | null;
}

interface IScheduleScheduled {
  type: "scheduled";
  intervalMinutes: number;
  startHour: number | null;
  startMinute: number | null;
  runOnce: boolean;
}
```

### 1.2 Schemas (`src/shared/schemas/cron.schemas.ts`)

Replace all schedule schemas with:
```typescript
export const scheduleScheduledSchema: z.ZodType<IScheduleScheduled> = z.object({
  type: z.literal("scheduled"),
  intervalMinutes: z.number().positive(),
  startHour: z.number().min(0).max(23).nullable(),
  startMinute: z.number().min(0).max(59).nullable(),
  runOnce: z.boolean().default(false),
});
```

### 1.3 Tool Schemas (`src/shared/schemas/tool-schemas.ts`)

**addCronToolInputSchema → addScheduledTaskToolInputSchema:**

```typescript
export const addScheduledTaskToolInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  instructions: z.string().min(1),
  tools: z.array(z.string()).min(1),
  scheduleIntervalMinutes: z.number().positive(),
  scheduleStartHour: z.number().min(0).max(23).optional(),
  scheduleStartMinute: z.number().min(0).max(59).optional(),
  runOnce: z.boolean().optional().default(false),
  notifyUser: z.boolean(),
});
```

- Rename `scheduleCron` → `scheduleIntervalMinutes`, `scheduleStartHour`, `scheduleStartMinute`
- Add `runOnce` field
- Remove `scheduleType` enum (only one type now)

---

## Phase 2: SchedulerService Changes

### 2.1 Remove Croner Dependency

In `src/services/cron-scheduler.ts`:
- Remove `import { Cron } from "croner"`
- Remove all croner usage in `_calculateNextRun()`
- Keep interval-based calculation logic:
```typescript
private _calculateNextRun(
  intervalMinutes: number,
  startHour: number | null,
  startMinute: number | null,
  after?: Date,
): Date {
  const now = after ?? new Date();
  
  if (startHour === null && startMinute === null) {
    return new Date(now.getTime() + intervalMinutes * 60_000);
  }
  
  // Build candidate at startHour:startMinute, advance if in past
  // ... (existing langchain logic)
}
```

### 2.2 Add Migration Methods

Add to `src/services/scheduler.service.ts`:

```typescript
private async _migrateAllSchedulesAsync(cronDir: string, jsonFiles: string[]): Promise<void> {
  // 1. Migrate cron expressions to scheduled
  await this._migrateCronExpressionSchedulesAsync(cronDir, jsonFiles);
  
  // 2. Migrate interval (ms) to scheduled (minutes)
  await this._migrateIntervalSchedulesAsync(cronDir, jsonFiles);
  
  // 3. Migrate once to scheduled with runOnce: true
  await this._migrateOnceSchedulesAsync(cronDir, jsonFiles);
}

private async _migrateCronExpressionSchedulesAsync(cronDir: string, jsonFiles: string[]): Promise<void> {
  for (const fileName of jsonFiles) {
    const filePath = path.join(cronDir, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    const raw = JSON.parse(content);
    
    const schedule = raw.schedule;
    if (!schedule || schedule.type !== "cron") continue;
    
    const converted = this._convertCronExpressionToScheduled(schedule.expression);
    if (!converted) {
      this._logger.warn("Could not migrate cron expression", { filePath, expression: schedule.expression });
      continue;
    }
    
    raw.schedule = {
      type: "scheduled",
      intervalMinutes: converted.intervalMinutes,
      startHour: converted.startHour,
      startMinute: converted.startMinute,
      runOnce: false,
    };
    raw.updatedAt = new Date().toISOString();
    
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8");
  }
}

private _convertCronExpressionToScheduled(expression: string): { intervalMinutes: number; startHour: number | null; startMinute: number | null } | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return null;
  
  const [minute, hour] = parts;
  const minuteParsed = this._parseCronMinute(minute);
  const hourParsed = this._parseCronHour(hour);
  
  if (!minuteParsed || !hourParsed) return null;
  
  // Cases:
  // "0 8 * * *" → { intervalMinutes: 1440, startHour: 8, startMinute: 0 }
  // "*/2 * * * *" → { intervalMinutes: 120, startHour: null, startMinute: null }
  // "30 * * * *" → { intervalMinutes: 60, startHour: null, startMinute: 30 }
  // "*/15 * * * *" → { intervalMinutes: 15, startHour: null, startMinute: null }
  // ...etc
}

private async _migrateIntervalSchedulesAsync(cronDir: string, jsonFiles: string[]): Promise<void> {
  for (const fileName of jsonFiles) {
    const filePath = path.join(cronDir, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    const raw = JSON.parse(content);
    
    const schedule = raw.schedule;
    if (!schedule || schedule.type !== "interval") continue;
    
    raw.schedule = {
      type: "scheduled",
      intervalMinutes: Math.round(schedule.intervalMs / 60000),
      startHour: null,
      startMinute: null,
      runOnce: false,
    };
    raw.updatedAt = new Date().toISOString();
    
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8");
  }
}

private async _migrateOnceSchedulesAsync(cronDir: string, jsonFiles: string[]): Promise<void> {
  for (const fileName of jsonFiles) {
    const filePath = path.join(cronDir, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    const raw = JSON.parse(content);
    
    const schedule = raw.schedule;
    if (!schedule || schedule.type !== "once") continue;
    
    // Calculate interval from runAt - use 1440 (daily) as default since it's in the past
    const runAt = new Date(schedule.runAt);
    const now = new Date();
    
    raw.schedule = {
      type: "scheduled",
      intervalMinutes: 1440, // Default to daily
      startHour: runAt.getHours(),
      startMinute: runAt.getMinutes(),
      runOnce: true,
    };
    raw.updatedAt = new Date().toISOString();
    
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8");
  }
}
```

### 2.3 Add runOnce Logic

In `_scheduleTask()`, after successful execution:

```typescript
if (task.schedule.runOnce) {
  task.enabled = false;
  task.updatedAt = new Date().toISOString();
  this._tasks.set(task.taskId, task);
  await this._saveTaskAsync(task);
  
  this._logger.info("One-time task completed and disabled", {
    taskId: task.taskId,
    name: task.name,
  });
}
```

### 2.4 Update _scheduleTask()

Remove `case "cron":` and `case "interval":` branches, keep only `case "scheduled":`:

```typescript
switch (schedule.type) {
  case "scheduled": {
    const nextRun = this._cronScheduler.addScheduledJob(
      task.taskId,
      schedule.intervalMinutes,
      schedule.startHour,
      schedule.startMinute,
      timezone,
      () => { this._dispatchOrEnqueue(task, executeCallback); },
    );
    break;
  }
  // Removed: case "cron": and case "interval":
}
```

---

## Phase 3: Tool Updates

### 3.1 Rename Tools

| Current | New |
|---------|-----|
| `add-cron.tool.ts` | `add-scheduled-task.tool.ts` |
| `edit-cron.tool.ts` | `edit-scheduled-task.tool.ts` |
| `edit-cron-instructions.tool.ts` | `edit-scheduled-task-instructions.tool.ts` |
| `get-cron.tool.ts` | `get-scheduled-task.tool.ts` |
| `remove-cron.tool.ts` | `remove-scheduled-task.tool.ts` |
| `list-crons.tool.ts` | `list-scheduled-tasks.tool.ts` |
| `run-cron.tool.ts` | `run-scheduled-task.tool.ts` |

### 3.2 Tool Input Schema Updates

In each tool file:
- Import new `addScheduledTaskToolInputSchema` (or similar)
- Update `TOOL_NAME` to new name
- Update tool description to use "scheduled task" instead of "cron"
- Update `_buildSchedule()` to create `scheduled` type

### 3.3 Add runOnce to Edit Tool

In `edit-scheduled-task.tool.ts`:
```typescript
inputSchema: z.object({
  taskId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  scheduleIntervalMinutes: z.number().positive().optional(),
  scheduleStartHour: z.number().min(0).max(23).optional(),
  scheduleStartMinute: z.number().min(0).max(59).optional(),
  runOnce: z.boolean().optional(),
  notifyUser: z.boolean().optional(),
  enabled: z.boolean().optional(),
}),
```

---

## Phase 4: Agent & Registration Updates

### 4.1 Update main-agent.ts

```typescript
// Before
add_cron: addCronTool,
remove_cron: removeCronTool,
list_crons: listCronsTool,
get_cron: getCronTool,
edit_cron: editCronTool,
edit_cron_instructions: editCronInstructionsTool,
run_cron: runCronTool,

// After
add_scheduled_task: addScheduledTaskTool,
remove_scheduled_task: removeScheduledTaskTool,
list_scheduled_tasks: listScheduledTasksTool,
get_scheduled_task: getScheduledTaskTool,
edit_scheduled_task: editScheduledTaskTool,
edit_scheduled_task_instructions: editScheduledTaskInstructionsTool,
run_scheduled_task: runScheduledTaskTool,
```

### 4.2 Update cron-agent.ts

- Rename to `scheduled-task-agent.ts` (or keep as is, but update internal references)
- Update `list_scheduled_tasks` reference

### 4.3 Update tool-registry.ts

- Change `add_cron` → `add_scheduled_task` etc.

### 4.4 Update telegram/handler.ts

- Change tool name mappings

---

## Phase 5: Prompts Updates

### 5.1 cron-agent.md → scheduled-task-agent.md

Complete rewrite:
- Remove "cron" references, use "scheduled task"
- Add explanation of runOnce flag
- Add examples of new schedule format

### 5.2 main-agent.md

- Rename "Cron task preference" → "Scheduled task preference"
- Update all cron references to scheduled task

### 5.3 cron-update-workflow.md → scheduled-task-update-workflow.md

- Rewrite for new tool names and format

### 5.4 job-creation-guide.md

- Update scheduling section examples to use `scheduled` type with `intervalMinutes`

### 5.5 cron-descriptions.ts → scheduled-task-descriptions.ts

- Rename file
- Update all tool descriptions to use "scheduled task"

---

## Phase 6: Brain Interface Updates

### 6.1 brain.types.ts

- Replace `IScheduleCron` with `IScheduleScheduled`
- Update dashboard component logic

### 6.2 dashboard.html

- Remove dead code checking `type === 'cron'`
- Add display for `runOnce` flag
- Update schedule display to show `intervalMinutes` instead of `expression`

---

## Phase 7: Tests

### 7.1 Migration Tests

Create `tests/unit/services/scheduler-migration.test.ts`:

```typescript
describe("Scheduler Migration", () => {
  describe("_convertCronExpressionToScheduled", () => {
    it("converts daily at 8:00", () => {
      const result = schedulerService["_convertCronExpressionToScheduled"]("0 8 * * *");
      expect(result).toEqual({ intervalMinutes: 1440, startHour: 8, startMinute: 0 });
    });
    
    it("converts every 2 hours", () => {
      const result = schedulerService["_convertCronExpressionToScheduled"]("0 */2 * * *");
      expect(result).toEqual({ intervalMinutes: 120, startHour: null, startMinute: 0 });
    });
    
    it("converts every 15 minutes", () => {
      const result = schedulerService["_convertCronExpressionToScheduled"]("*/15 * * * *");
      expect(result).toEqual({ intervalMinutes: 15, startHour: null, startMinute: null });
    });
    
    it("converts hourly at :30", () => {
      const result = schedulerService["_convertCronExpressionToScheduled"]("30 * * * *");
      expect(result).toEqual({ intervalMinutes: 60, startHour: null, startMinute: 30 });
    });
    
    it("returns null for unsupported patterns", () => {
      const result = schedulerService["_convertCronExpressionToScheduled"]("0 0 * * 1");
      expect(result).toBeNull(); // Day of week not supported
    });
  });
  
  describe("_migrateCronExpressionSchedulesAsync", () => {
    // Test migration of actual files
  });
  
  describe("_migrateIntervalSchedulesAsync", () => {
    // Test interval (ms) to scheduled (minutes) migration
  });
  
  describe("_migrateOnceSchedulesAsync", () => {
    // Test once to scheduled with runOnce: true migration
  });
});
```

### 7.2 runOnce Tests

Create `tests/unit/services/scheduler-run-once.test.ts`:

```typescript
describe("runOnce Behavior", () => {
  it("disables task after one successful run", async () => {
    const task = createTask({ schedule: { type: "scheduled", intervalMinutes: 60, startHour: null, startMinute: null, runOnce: true } });
    
    await schedulerService.addTaskAsync(task);
    await executeTask(task); // Simulate one run
    
    const updatedTask = await schedulerService.getTaskAsync(task.taskId);
    expect(updatedTask?.enabled).toBe(false);
  });
  
  it("keeps task enabled after run when runOnce is false", async () => {
    const task = createTask({ schedule: { type: "scheduled", intervalMinutes: 60, startHour: null, startMinute: null, runOnce: false } });
    
    await schedulerService.addTaskAsync(task);
    await executeTask(task);
    
    const updatedTask = await schedulerService.getTaskAsync(task.taskId);
    expect(updatedTask?.enabled).toBe(true);
  });
  
  it("can re-enable a runOnce task via edit", async () => {
    // ... test editing runOnce task to enabled: true
  });
});
```

### 7.3 Integration Tests

Update existing cron integration tests to use new format and tool names.

---

## File Changes Summary

### New Files
- `tests/unit/services/scheduler-migration.test.ts`
- `tests/unit/services/scheduler-run-once.test.ts`

### Delete
- Remove croner usage in cron-scheduler.ts (keep file but remove import)

### Rename
- `add-cron.tool.ts` → `add-scheduled-task.tool.ts`
- `edit-cron.tool.ts` → `edit-scheduled-task.tool.ts`
- `edit-cron-instructions.tool.ts` → `edit-scheduled-task-instructions.tool.ts`
- `get-cron.tool.ts` → `get-scheduled-task.tool.ts`
- `remove-cron.tool.ts` → `remove-scheduled-task.tool.ts`
- `list-crons.tool.ts` → `list-scheduled-tasks.tool.ts`
- `run-cron.tool.ts` → `run-scheduled-task.tool.ts`
- `cron-agent.md` → `scheduled-task-agent.md`
- `cron-update-workflow.md` → `scheduled-task-update-workflow.md`
- `cron-descriptions.ts` → `scheduled-task-descriptions.ts`

### Modify
- `src/shared/types/cron.types.ts` - New schedule type
- `src/shared/schemas/cron.schemas.ts` - New schemas
- `src/shared/schemas/tool-schemas.ts` - New tool input schemas
- `src/services/cron-scheduler.ts` - Remove croner
- `src/services/scheduler.service.ts` - Migration + runOnce logic
- `src/agent/main-agent.ts` - Tool registration
- `src/agent/cron-agent.ts` - References
- `src/helpers/tool-registry.ts` - Registry updates
- `src/platforms/telegram/handler.ts` - Tool mappings
- `src/defaults/prompts/main-agent.md` - Update references
- `src/defaults/prompts/job-creation-guide.md` - Update examples
- `brain-interface/src/app/models/brain.types.ts` - Type updates
- `brain-interface/src/app/components/dashboard/dashboard.html` - UI updates

---

## Implementation Order

1. **Types & Schemas** - Foundation layer
2. **SchedulerService** - Core logic + migration
3. **CronScheduler** - Remove croner
4. **Tools** - Rename + update
5. **Agents** - Update references
6. **Prompts** - Update documentation
7. **Brain Interface** - UI updates
8. **Tests** - Add migration + runOnce tests
9. **Verify** - Run typecheck + tests