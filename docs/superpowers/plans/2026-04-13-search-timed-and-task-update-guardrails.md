# Search Timed And Task Update Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic fuzzy scheduled-task discovery via `search_timed` and tighten timed-update workflow guidance so scheduled-task updates stay in scheduled-task tools.

**Architecture:** Introduce a dedicated `search_timed` tool backed by weighted deterministic fuzzy search (`fuse.js`) over scheduled-task metadata (`name`, `description`, `instructions`, `taskId`, `tools`). Register the tool across main/cron agents and schema/description registries, while keeping `list_timed` unchanged. Update prompt workflow text to direct users through `search_timed` -> `get_timed` -> `edit_*`/`edit_instructions`.

**Tech Stack:** TypeScript, Vitest, Zod, AI SDK tool wrappers, Fuse.js.

---

### Task 1: Tool Registration Contract (RED -> GREEN)

**Files:**
- Add: `tests/unit/tools/search-timed.registration.test.ts`
- Modify: `src/shared/schemas/tool-schemas.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Write failing registration tests (RED)**

Create `tests/unit/tools/search-timed.registration.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { CRON_VALID_TOOL_NAMES } from "../../../src/shared/schemas/tool-schemas.js";

describe("search_timed registration", () => {
  it("exports searchTimedTool from tools index", async () => {
    const toolsModule: Record<string, unknown> = await import("../../../src/tools/index.js");
    expect(toolsModule.searchTimedTool).toBeDefined();
  });

  it("registers search_timed as a valid cron tool name", () => {
    expect(CRON_VALID_TOOL_NAMES).toContain("search_timed");
  });
});
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run tests/unit/tools/search-timed.registration.test.ts`

Expected: FAIL because `searchTimedTool` export and `search_timed` tool-name registration do not exist yet.

- [ ] **Step 3: Implement minimal registration (GREEN)**

In `src/shared/schemas/tool-schemas.ts`, add `search_timed` to `CRON_VALID_TOOL_NAMES`:

```ts
export const CRON_VALID_TOOL_NAMES = [
  // ...existing entries...
  "list_timed",
  "search_timed",
  "fetch_rss",
  // ...
] as const;
```

In `src/tools/index.ts`, add export placeholder that will be implemented in Task 2:

```ts
export { searchTimedTool } from "./search-timed.tool.js";
```

- [ ] **Step 4: Re-run test to verify GREEN**

Run: `pnpm vitest run tests/unit/tools/search-timed.registration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add tests/unit/tools/search-timed.registration.test.ts src/shared/schemas/tool-schemas.ts src/tools/index.ts
git commit -m "test: lock search_timed registration contract"
```


### Task 2: Search Tool Behavior With Deterministic Fuzzy Ranking (RED -> GREEN)

**Files:**
- Add: `tests/unit/tools/search-timed.tool.test.ts`
- Add: `src/tools/search-timed.tool.ts`
- Modify: `src/shared/schemas/tool-schemas.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing behavior tests (RED)**

Create `tests/unit/tools/search-timed.tool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { searchTimedTool } from "../../../src/tools/search-timed.tool.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";

describe("searchTimedTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ranked matches with score and matchedFields", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([
        {
          taskId: "Cr4VUK3jUp29",
          name: "fetch_second_feed",
          description: "Fetch RSS feed every hour",
          instructions: "Fetch from http://127.0.0.1:8080/i/lists/1482337753052426240/rss",
          tools: ["fetch_rss", "send_message"],
          schedule: { type: "interval", every: { hours: 1, minutes: 0 }, offsetFromDayStart: { hours: 0, minutes: 45 }, timezone: "UTC" },
          enabled: true,
          notifyUser: true,
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageHistory: [],
          messageSummary: null,
          summaryGeneratedAt: null,
          messageDedupEnabled: true,
        },
        {
          taskId: "TmbxXIyMKK6i",
          name: "fetch_rageintel_feed",
          description: "Different source",
          instructions: "Fetch from https://example.com/rss",
          tools: ["fetch_rss"],
          schedule: { type: "interval", every: { hours: 2, minutes: 0 }, offsetFromDayStart: { hours: 1, minutes: 0 }, timezone: "UTC" },
          enabled: true,
          notifyUser: true,
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageHistory: [],
          messageSummary: null,
          summaryGeneratedAt: null,
          messageDedupEnabled: true,
        },
      ]),
      getTasksByEnabled: vi.fn().mockReturnValue([]),
    } as unknown as SchedulerService;

    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock);

    const result = await (searchTimedTool.execute as any)({
      query: "127.0.0.1 list rss",
      enabledOnly: false,
      limit: 5,
      threshold: 0.4,
    });

    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.matches[0].taskId).toBe("Cr4VUK3jUp29");
    expect(result.matches[0].score).toBeGreaterThan(0);
    expect(result.matches[0].matchedFields.length).toBeGreaterThan(0);
    expect(result.matches[0].preview.instructions.length).toBeGreaterThan(0);
  });

  it("respects enabledOnly and limit", async () => {
    const schedulerMock = {
      getAllTasks: vi.fn().mockReturnValue([]),
      getTasksByEnabled: vi.fn().mockReturnValue([
        {
          taskId: "only-enabled",
          name: "enabled task",
          description: "desc",
          instructions: "text",
          tools: ["fetch_rss"],
          schedule: { type: "interval", every: { hours: 1, minutes: 0 }, offsetFromDayStart: { hours: 0, minutes: 0 }, timezone: "UTC" },
          enabled: true,
          notifyUser: true,
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageHistory: [],
          messageSummary: null,
          summaryGeneratedAt: null,
          messageDedupEnabled: true,
        },
      ]),
    } as unknown as SchedulerService;

    vi.spyOn(SchedulerService, "getInstance").mockReturnValue(schedulerMock);

    const result = await (searchTimedTool.execute as any)({
      query: "enabled",
      enabledOnly: true,
      limit: 1,
      threshold: 0.4,
    });

    expect(schedulerMock.getTasksByEnabled).toHaveBeenCalledWith(true);
    expect(result.matches).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run tests/unit/tools/search-timed.tool.test.ts`

Expected: FAIL because `search_timed` behavior and schema are not implemented.

- [ ] **Step 3: Add input/output schemas for `search_timed` (GREEN part 1)**

In `src/shared/schemas/tool-schemas.ts`, add:

```ts
export const searchTimedToolInputSchema = z.object({
  query: z.string().min(1).describe("Fuzzy query used to find matching scheduled tasks"),
  enabledOnly: z.boolean().default(false).describe("Only include enabled scheduled tasks"),
  limit: z.number().int().positive().max(20).default(5).describe("Maximum matches to return"),
  threshold: z.number().min(0).max(1).default(0.4).describe("Fuse threshold (lower is stricter)"),
});

export const searchTimedToolOutputSchema = z.object({
  query: z.string(),
  totalMatches: z.number().int().nonnegative(),
  matches: z.object({
    taskId: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    schedule: z.any(),
    score: z.number(),
    matchedFields: z.string().array(),
    preview: z.object({ instructions: z.string() }),
  }).array(),
});
```

- [ ] **Step 4: Implement minimal search tool with Fuse.js (GREEN part 2)**

Add `src/tools/search-timed.tool.ts`:

```ts
import { tool } from "ai";
import Fuse from "fuse.js";

import { searchTimedToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import type { IScheduledTask } from "../shared/types/index.js";

interface ISearchableTask {
  taskId: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  enabled: boolean;
  schedule: IScheduledTask["schedule"];
}

function _truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

export const searchTimedTool = tool({
  description: "Search scheduled tasks by fuzzy similarity across taskId, name, description, instructions, and tools.",
  inputSchema: searchTimedToolInputSchema,
  execute: async ({ query, enabledOnly, limit, threshold }: { query: string; enabledOnly: boolean; limit: number; threshold: number }) => {
    const scheduler: SchedulerService = SchedulerService.getInstance();
    const sourceTasks: IScheduledTask[] = enabledOnly
      ? scheduler.getTasksByEnabled(true)
      : scheduler.getAllTasks();

    const searchableTasks: ISearchableTask[] = sourceTasks.map((task: IScheduledTask): ISearchableTask => ({
      taskId: task.taskId,
      name: task.name,
      description: task.description,
      instructions: task.instructions,
      tools: task.tools,
      enabled: task.enabled,
      schedule: task.schedule,
    }));

    const fuse: Fuse<ISearchableTask> = new Fuse(searchableTasks, {
      includeScore: true,
      includeMatches: true,
      ignoreLocation: true,
      minMatchCharLength: 2,
      threshold,
      keys: [
        { name: "name", weight: 0.4 },
        { name: "description", weight: 0.25 },
        { name: "instructions", weight: 0.2 },
        { name: "taskId", weight: 0.1 },
        { name: "tools", weight: 0.05 },
      ],
    });

    const raw = fuse.search(query, { limit });

    const matches = raw.map((entry) => {
      const matchedFields: string[] = Array.from(new Set((entry.matches ?? [])
        .map((m) => m.key)
        .filter((k): k is string => typeof k === "string")));

      const normalizedScore: number = Math.max(0, Math.min(1, 1 - (entry.score ?? 1)));

      return {
        taskId: entry.item.taskId,
        name: entry.item.name,
        description: entry.item.description,
        enabled: entry.item.enabled,
        schedule: entry.item.schedule,
        score: Number(normalizedScore.toFixed(4)),
        matchedFields,
        preview: {
          instructions: _truncate(entry.item.instructions, 160),
        },
      };
    });

    return {
      query,
      totalMatches: matches.length,
      matches,
    };
  },
});
```

- [ ] **Step 5: Add dependency for Fuse.js**

In `package.json` dependencies:

```json
"fuse.js": "^7.0.0"
```

Run: `pnpm install`

Expected: lockfile updated with Fuse.js.

- [ ] **Step 6: Re-run behavior tests to verify GREEN**

Run: `pnpm vitest run tests/unit/tools/search-timed.tool.test.ts tests/unit/tools/search-timed.registration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add tests/unit/tools/search-timed.tool.test.ts src/tools/search-timed.tool.ts src/shared/schemas/tool-schemas.ts src/tools/index.ts package.json pnpm-lock.yaml
git commit -m "feat: add deterministic fuzzy search_timed tool"
```


### Task 3: Register `search_timed` In Agent Toolsets And Cron Descriptions (RED -> GREEN)

**Files:**
- Add: `tests/unit/tools/search-timed.integration-registration.test.ts`
- Modify: `src/agent/main-agent.ts`
- Modify: `src/agent/cron-agent.ts`
- Modify: `src/shared/constants/cron-descriptions.ts`

- [ ] **Step 1: Write failing agent-registration tests (RED)**

Create `tests/unit/tools/search-timed.integration-registration.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { CRON_TOOL_DESCRIPTIONS } from "../../../src/shared/constants/cron-descriptions.js";

describe("search_timed integration registration", () => {
  it("defines cron description for search_timed", () => {
    expect(CRON_TOOL_DESCRIPTIONS.search_timed).toBeDefined();
    expect(CRON_TOOL_DESCRIPTIONS.search_timed).toContain("scheduled tasks");
  });
});
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run tests/unit/tools/search-timed.integration-registration.test.ts`

Expected: FAIL because `CRON_TOOL_DESCRIPTIONS.search_timed` does not exist yet.

- [ ] **Step 3: Wire tool into main and cron tool maps (GREEN part 1)**

In `src/agent/main-agent.ts` imports + tool map:

```ts
import {
  // ...
  searchTimedTool,
} from "../tools/index.js";

const tools: ToolSet = {
  // ...
  list_timed: listTimedTool,
  search_timed: searchTimedTool,
  get_timed: getTimedTool,
  // ...
};
```

In `src/agent/cron-agent.ts` imports + available tools:

```ts
import {
  // ...
  listTimedTool,
  searchTimedTool,
  // ...
} from "../tools/index.js";

const availableTools: Record<string, Tool> = {
  // ...
  list_timed: listTimedTool,
  search_timed: searchTimedTool,
  // ...
};
```

- [ ] **Step 4: Add cron description entry (GREEN part 2)**

In `src/shared/constants/cron-descriptions.ts`:

```ts
search_timed:
  "Search scheduled tasks by fuzzy similarity across taskId, name, description, instructions, and tools. " +
  "Use this when task ID is unknown and the user references partial text/URLs. " +
  "Args: query (string, required); enabledOnly (boolean, default false); limit (number, default 5); threshold (number 0..1, default 0.4).",
```

- [ ] **Step 5: Re-run tests to verify GREEN**

Run: `pnpm vitest run tests/unit/tools/search-timed.integration-registration.test.ts tests/unit/tools/search-timed.tool.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add tests/unit/tools/search-timed.integration-registration.test.ts src/agent/main-agent.ts src/agent/cron-agent.ts src/shared/constants/cron-descriptions.ts
git commit -m "feat: register search_timed across agent toolsets"
```


### Task 4: Timed-Update Workflow Guidance (RED -> GREEN)

**Files:**
- Modify: `tests/integration/core/prompt-service.test.ts`
- Modify: `src/defaults/prompts/prompt-fragments/timed-update-workflow.md`

- [ ] **Step 1: Write failing prompt-resolution test (RED)**

In `tests/integration/core/prompt-service.test.ts`, add:

```ts
it("should include search_timed-first workflow for task lookup", async () => {
  const service: PromptService = PromptService.getInstance();
  await service.initializeAsync();

  const content: string = await service.getPromptAsync("main-agent");

  expect(content).toContain("search_timed");
  expect(content).toContain("get_timed");
  expect(content).toContain("edit_instructions");
});
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run tests/integration/core/prompt-service.test.ts -t "search_timed-first workflow"`

Expected: FAIL because current timed workflow fragment does not include `search_timed` guidance.

- [ ] **Step 3: Update timed workflow fragment text (GREEN)**

In `src/defaults/prompts/prompt-fragments/timed-update-workflow.md`, update workflow to include:

```md
1. If taskId is unknown, call `search_timed` with user-provided identifiers (name fragments, URL fragments, description text) to identify candidate tasks.
2. Call `get_timed` for the selected task to inspect full current configuration.
3. If textual instructions must change, use `edit_instructions` with COMPLETE new instructions + intention.
4. Use `edit_once` or `edit_interval` for non-instruction fields.
```

Keep wording focused on scheduled-task tool flow only.

- [ ] **Step 4: Re-run prompt test to verify GREEN**

Run: `pnpm vitest run tests/integration/core/prompt-service.test.ts -t "search_timed-first workflow"`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add tests/integration/core/prompt-service.test.ts src/defaults/prompts/prompt-fragments/timed-update-workflow.md
git commit -m "docs: guide timed updates through search_timed and get_timed"
```


### Task 5: Verification Pass

**Files:**
- No new files (verification only)

- [ ] **Step 1: Run targeted new/changed tests**

Run:

```bash
pnpm vitest run \
  tests/unit/tools/search-timed.registration.test.ts \
  tests/unit/tools/search-timed.tool.test.ts \
  tests/unit/tools/search-timed.integration-registration.test.ts \
  tests/integration/core/prompt-service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run tool-related existing tests**

Run:

```bash
pnpm vitest run \
  tests/unit/tools/list-timed.tool.test.ts \
  tests/unit/tools/get-timed.tool.test.ts \
  tests/unit/tools/edit-interval.tool.test.ts \
  tests/unit/tools/run-timed-prerequisites.test.ts
```

Expected: PASS (regression guard for timed tooling).

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Review working tree scope**

Run: `git status --short`

Expected: only intended files changed.

- [ ] **Step 5: Final commit**

```bash
git add src/tools/search-timed.tool.ts src/tools/index.ts src/agent/main-agent.ts src/agent/cron-agent.ts src/shared/schemas/tool-schemas.ts src/shared/constants/cron-descriptions.ts src/defaults/prompts/prompt-fragments/timed-update-workflow.md tests/unit/tools/search-timed.registration.test.ts tests/unit/tools/search-timed.tool.test.ts tests/unit/tools/search-timed.integration-registration.test.ts tests/integration/core/prompt-service.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add search_timed and tighten scheduled-task update workflow"
```
