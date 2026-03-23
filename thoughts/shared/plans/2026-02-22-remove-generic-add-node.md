# Remove Generic add_node Tool Implementation Plan

**Goal:** Remove the generic `add_node` tool end-to-end and add a defensive guard for invalid agent node configs.

**Architecture:** Delete the generic tool implementation and its schemas/exports/registrations so it cannot be used. Add a runtime guard in the job executor to throw a clear error when `selectedTools` is missing or empty. Design requires removing all references; I’m also removing the `add_node` entry from Telegram tool key mapping to avoid dangling references.

**Design:** `thoughts/shared/designs/2026-02-22-remove-generic-add-node-design.md`

---

## Dependency Graph

```
Batch 1 (parallel): 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 [foundation - no deps]
```

---

## Batch 1: Foundation (parallel - 6 implementers)

All tasks in this batch have NO dependencies and run simultaneously.

### Task 1.1: Delete generic add_node tool implementation
**File:** `src/tools/add-node.tool.ts`
**Test:** none (do not modify tests per design)
**Depends:** none

```ts
// Delete this file entirely.
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `chore(tools): remove generic add_node tool implementation`

---

### Task 1.2: Remove add_node schemas
**File:** `src/shared/schemas/tool-schemas.ts`
**Test:** none (do not modify tests per design)
**Depends:** none

```ts
//#region Node Tools

export const editNodeToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
  name: z.string()
    .optional(),
  description: z.string()
    .optional(),
  inputSchema: z.record(z.string(), z.unknown())
    .optional(),
  outputSchema: z.record(z.string(), z.unknown())
    .optional(),
  config: z.record(z.string(), z.unknown())
    .optional(),
});

export const editNodeToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const removeNodeToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
});

export const removeNodeToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const connectNodesToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  fromNodeId: z.string()
    .min(1)
    .describe("Source node ID"),
  toNodeId: z.string()
    .min(1)
    .describe("Target node ID"),
});

export const connectNodesToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  schemaCompatible: z.boolean()
    .describe("Whether the output/input schemas are compatible"),
});

export const setEntrypointToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
});

export const setEntrypointToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const addNodeTestToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
  name: z.string()
    .min(1)
    .describe("Test case name"),
  inputData: z.record(z.string(), z.unknown())
    .describe("Test input data"),
});

export const addNodeTestToolOutputSchema = z.object({
  testId: z.string(),
  success: z.boolean(),
});

export const runNodeTestToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
});

export const runNodeTestToolOutputSchema = z.object({
  results: z.object({
    testId: z.string(),
    name: z.string(),
    passed: z.boolean(),
    error: z.string()
      .nullable(),
    validationErrors: z.string()
      .array(),
    executionTimeMs: z.number(),
  })
    .array(),
  allPassed: z.boolean(),
});

//#endregion Node Tools
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `chore(schemas): remove add_node schemas`

---

### Task 1.3: Remove add_node tool export
**File:** `src/tools/index.ts`
**Test:** none (do not modify tests per design)
**Depends:** none

```ts
export { thinkTool } from "./think.tool.js";
// legacy export removed
export { runCmdTool } from "./run-cmd.tool.js";
export { createSendMessageTool, type MessageSender } from "./send-message.tool.js";
export { modifyPromptTool } from "./modify-prompt.tool.js";
export { listPromptsTool } from "./list-prompts.tool.js";
export { searchKnowledgeTool } from "./search-knowledge.tool.js";
export { addKnowledgeTool } from "./add-knowledge.tool.js";
export { editKnowledgeTool } from "./edit-knowledge.tool.js";
export { addJobTool } from "./add-job.tool.js";
export { editJobTool } from "./edit-job.tool.js";
export { createRemoveJobTool } from "./remove-job.tool.js";
export { getJobsTool } from "./get-jobs.tool.js";
export { getNodesTool } from "./get-nodes.tool.js";
export { clearJobGraphTool } from "./clear-job-graph.tool.js";
export { createRunJobTool, type NodeProgressEmitter } from "./run-job.tool.js";
export { finishJobTool } from "./finish-job.tool.js";
export { createEditNodeTool } from "./edit-node.tool.js";
export { removeNodeTool } from "./remove-node.tool.js";
export { connectNodesTool } from "./connect-nodes.tool.js";
export { disconnectNodesTool } from "./disconnect-nodes.tool.js";
export { setEntrypointTool } from "./set-entrypoint.tool.js";
export { addNodeTestTool } from "./add-node-test.tool.js";
export { runNodeTestTool } from "./run-node-test.tool.js";
export { callSkillTool } from "./call-skill.tool.js";
export { getSkillFileTool } from "./get-skill-file.tool.js";
export { addCronTool } from "./add-cron.tool.js";
export { removeCronTool } from "./remove-cron.tool.js";
export { listCronsTool } from "./list-crons.tool.js";
export { setJobScheduleTool } from "./set-job-schedule.tool.js";
export { removeJobScheduleTool } from "./remove-job-schedule.tool.js";
export { createRenderGraphTool, type PhotoSender } from "./render-graph.tool.js";
export { createReadFileTool } from "./read-file.tool.js";
export { createWriteFileTool } from "./write-file.tool.js";
export { appendFileTool } from "./append-file.tool.js";
export { editFileTool } from "./edit-file.tool.js";
export { fetchRssTool } from "./fetch-rss.tool.js";
export { listDatabasesTool } from "./list-databases.tool.js";
export { listTablesTool } from "./list-tables.tool.js";
export { getTableSchemaTool } from "./get-table-schema.tool.js";
export { createDatabaseTool } from "./create-database.tool.js";
export { createTableTool } from "./create-table.tool.js";
export { dropTableTool } from "./drop-table.tool.js";
export { queryDatabaseTool } from "./query-database.tool.js";
export { readFromDatabaseTool } from "./read-from-database.tool.js";
export { writeToDatabaseTool } from "./write-to-database.tool.js";
export { FileReadTracker } from "../utils/file-tools-helper.js";
export type { IFileReadTracker } from "../utils/file-tools-helper.js";
export { JobActivityTracker } from "../utils/job-activity-tracker.js";
export type { IJobActivityTracker } from "../utils/job-activity-tracker.js";
export type { IJobCreationModeTracker, IJobCreationMode } from "../utils/job-creation-mode-tracker.js";
export { createStartJobCreationTool } from "./start-job-creation.tool.js";
export { createAddCurlFetcherNodeTool } from "./add-curl-fetcher-node.tool.js";
export { createAddRssFetcherNodeTool } from "./add-rss-fetcher-node.tool.js";
export { createAddCrawl4aiNodeTool } from "./add-crawl4ai-node.tool.js";
export { createAddSearxngNodeTool } from "./add-searxng-node.tool.js";
export { createAddPythonCodeNodeTool } from "./add-python-code-node.tool.js";
export { createAddOutputToAiNodeTool } from "./add-output-to-ai-node.tool.js";
export { createAddAgentNodeTool } from "./add-agent-node.tool.js";
export { createAddLitesqlNodeTool } from "./add-litesql-node.tool.js";
export { createFinishJobCreationTool } from "./finish-job-creation.tool.js";
export { createCreateOutputSchemaTool } from "./create-output-schema.tool.js";
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `chore(tools): drop add_node export`

---

### Task 1.4: Remove add_node registration and mutating tool entry
**File:** `src/agent/main-agent.ts`
**Test:** none (do not modify tests per design)
**Depends:** none

```ts
import {
  thinkTool,
  runCmdTool,
  modifyPromptTool,
  listPromptsTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
  type MessageSender,
  addJobTool,
  editJobTool,
  createRemoveJobTool,
  getJobsTool,
  createRunJobTool,
  finishJobTool,
  type NodeProgressEmitter,
  createEditNodeTool,
  removeNodeTool,
  connectNodesTool,
  disconnectNodesTool,
  setEntrypointTool,
  addNodeTestTool,
  runNodeTestTool,
  getNodesTool,
  clearJobGraphTool,
  callSkillTool,
  getSkillFileTool,
  addCronTool,
  removeCronTool,
  listCronsTool,
  createRenderGraphTool,
  type PhotoSender,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  fetchRssTool,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  createDatabaseTool,
  createTableTool,
  dropTableTool,
  queryDatabaseTool,
  // legacy creator removed
  FileReadTracker,
  JobActivityTracker,
  type IJobCreationModeTracker,
  type IJobCreationMode,
  createStartJobCreationTool,
  createFinishJobCreationTool,
  createCreateOutputSchemaTool,
  createAddCurlFetcherNodeTool,
  createAddRssFetcherNodeTool,
  createAddCrawl4aiNodeTool,
  createAddSearxngNodeTool,
  createAddPythonCodeNodeTool,
  createAddOutputToAiNodeTool,
  createAddAgentNodeTool,
  createAddLitesqlNodeTool,
  setJobScheduleTool,
  removeJobScheduleTool,
} from "../tools/index.js";

// ...

const _GraphMutatingTools: Set<string> = new Set([
  "edit_node",
  "remove_node",
  "connect_nodes",
  "disconnect_nodes",
  "set_entrypoint",
  "clear_job_graph",
  "start_job_creation",
  "add_curl_fetcher_node",
  "add_rss_fetcher_node",
  "add_crawl4ai_node",
  "add_searxng_node",
  "add_python_code_node",
  "add_output_to_ai_node",
  "add_agent_node",
  "add_litesql_node",
  "finish_job_creation",
]);

// ...

    const tools: ToolSet = {
      think: thinkTool,
      run_cmd: runCmdTool,
      modify_prompt: modifyPromptTool,
      list_prompts: listPromptsTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(messageSender),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
      add_job: addJobTool,
      edit_job: editJobTool,
      remove_job: createRemoveJobTool(creationModeTracker),
      get_jobs: getJobsTool,
      run_job: createRunJobTool(jobTracker, nodeProgressEmitter),
      finish_job: finishJobTool,
      edit_node: createEditNodeTool(jobTracker),
      remove_node: removeNodeTool,
      connect_nodes: connectNodesTool,
      disconnect_nodes: disconnectNodesTool,
      set_entrypoint: setEntrypointTool,
      add_node_test: addNodeTestTool,
      run_node_test: runNodeTestTool,
      get_nodes: getNodesTool,
      clear_job_graph: clearJobGraphTool,
      call_skill: callSkillTool,
      get_skill_file: getSkillFileTool,
      add_cron: addCronTool,
      remove_cron: removeCronTool,
      list_crons: listCronsTool,
      set_job_schedule: setJobScheduleTool,
      remove_job_schedule: removeJobScheduleTool,
      render_graph: createRenderGraphTool(photoSender),
      fetch_rss: fetchRssTool,
      list_databases: listDatabasesTool,
      list_tables: listTablesTool,
      get_table_schema: getTableSchemaTool,
      create_database: createDatabaseTool,
      create_table: createTableTool,
      drop_table: dropTableTool,
      query_database: queryDatabaseTool,
      // start_job_creation is always available (entry point for mode)
      start_job_creation: createStartJobCreationTool(jobTracker, creationModeTracker),
    };
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `chore(agent): remove add_node tool registration`

---

### Task 1.5: Remove add_node from Telegram tool primary key mapping
**File:** `src/telegram/handler.ts`
**Test:** none (do not modify tests per design)
**Depends:** none

```ts
const TOOL_PRIMARY_KEY: Record<string, string> = {
  run_cmd: "command",
  fetch_rss: "url",
  search_knowledge: "query",
  add_knowledge: "knowledge",
  edit_knowledge: "id",
  add_job: "name",
  edit_job: "jobId",
  remove_job: "jobId",
  run_job: "jobId",
  finish_job: "jobId",
  edit_node: "nodeId",
  remove_node: "nodeId",
  connect_nodes: "fromNodeId",
  set_entrypoint: "nodeId",
  call_skill: "skillName",
  get_skill_file: "skillName",
  modify_prompt: "promptName",
  send_message: "message",
  read_file: "filePath",
  write_file: "filePath",
  append_file: "filePath",
  edit_file: "filePath",
  render_graph: "jobId",
  add_cron: "name",
  remove_cron: "taskId",
  think: "thought",
  done: "summary",
};
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `chore(telegram): remove add_node tool key mapping`

---

### Task 1.6: Add defensive guard for selectedTools
**File:** `src/services/job-executor.service.ts`
**Test:** none (do not modify tests per design)
**Depends:** none

```ts
    // Build the tool set from selected tools
    const toolPool: Record<string, ToolSet[string]> = createAgentNodeToolPool(this._logger);
    const selectedTools: ToolSet = {};

    if (!Array.isArray(config.selectedTools) || config.selectedTools.length === 0) {
      throw new Error("Agent node config is invalid: selectedTools must be a non-empty array.");
    }

    for (const toolName of config.selectedTools) {
      if (toolName === 'think') continue;

      if (toolPool[toolName]) {
        selectedTools[toolName] = toolPool[toolName];
      } else {
        this._logger.warn(`Agent node requested unknown tool: ${toolName}`, { nodeId: node.nodeId });
      }
    }
```

**Verify:** `pnpm tsc --noEmit`
**Commit:** `fix(executor): guard invalid agent selectedTools`

---

## Validation & Notes

- Run required checks (do not truncate output):
  - `pnpm tsc --noEmit` (ignore pre-existing errors in `tests/integration/disconnect-nodes.test.ts`, `src/tools/index.ts` clear-job-graph import, and `node_modules/ai/`)
  - `pnpm vitest run --config vitest.unit.config.ts --reporter=verbose`
  - `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose`

- No tests are modified per design.
