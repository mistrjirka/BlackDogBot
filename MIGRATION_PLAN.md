# BlackDogBot → LangChain + DeepAgents Migration Plan

## Overview

Migrate BlackDogBot from Vercel AI SDK (`ai` package) to LangChain JS with DeepAgents (`deepagents` npm package).
Remove the entire jobs system. Keep crons as the primary scheduled task mechanism.
Convert MCP integration to `@langchain/mcp-adapters`.
Delete the BrainInterface WebSocket server.

## Key Decisions

- **Jobs removed entirely** — node graph tools, job executor, job storage, BrainInterface WebSocket
- **Crons preserved** — `SchedulerService`, `cron-task-executor`, all 7 cron tools
- **DeepAgents harness** — replaces custom agent loop, compaction, session management
- **LangGraph checkpointer** — replaces JSON file sessions with SQLite checkpoints
- **LangChain MCP adapters** — replaces custom MCP service
- **`CompositeBackend`** — StateBackend (ephemeral workspace) + StoreBackend (persistent memories)

---

## Phase 0: Jobs Removal

**Goal**: Strip the entire jobs system. Keep crons, main agent, all non-job tools.
**Branch**: Work directly on `main` (independent of LangChain migration).
**Estimated lines removed**: ~4,000+

### Step 0.1: Delete job tool files (30 files)

```
src/tools/add-job.tool.ts
src/tools/edit-job.tool.ts
src/tools/remove-job.tool.ts
src/tools/get-jobs.tool.ts
src/tools/start-job-creation.tool.ts
src/tools/finish-job-creation.tool.ts
src/tools/finish-job.tool.ts
src/tools/run-job.tool.ts
src/tools/clear-job-graph.tool.ts
src/tools/set-job-schedule.tool.ts
src/tools/remove-job-schedule.tool.ts
src/tools/add-agent-node.tool.ts
src/tools/add-crawl4ai-node.tool.ts
src/tools/add-curl-fetcher-node.tool.ts
src/tools/add-litesql-node.tool.ts
src/tools/add-litesql-reader-node.tool.ts
src/tools/add-node-test.tool.ts
src/tools/add-output-to-ai-node.tool.ts
src/tools/add-python-code-node.tool.ts
src/tools/add-rss-fetcher-node.tool.ts
src/tools/add-searxng-node.tool.ts
src/tools/add-node-test.tool.ts
src/tools/connect-nodes.tool.ts
src/tools/disconnect-nodes.tool.ts
src/tools/edit-node.tool.ts
src/tools/get-nodes.tool.ts
src/tools/remove-node.tool.ts
src/tools/run-node-test.tool.ts
src/tools/set-entrypoint.tool.ts
src/tools/render-graph.tool.ts
src/tools/create-output-schema.tool.ts
```

### Step 0.2: Delete job services (2 files)

```
src/services/job-executor.service.ts
src/services/job-storage.service.ts
```

### Step 0.3: Delete BrainInterface (entire directory, 2 files)

```
src/brain-interface/service.ts
src/brain-interface/types.ts
```

### Step 0.4: Delete job-only utilities (6 files)

```
src/utils/node-tool-factory.ts          — used by job tools only
src/utils/node-creation-helper.ts       — used by job tools only
src/utils/job-activity-tracker.ts       — used by job tools only
src/utils/job-creation-mode-tracker.ts  — used by main-agent (job mode)
src/utils/agent-node-tool-pool.ts       — used by job executor only
src/utils/ascii-graph.ts                — used by node tools only
src/utils/graph-audit.ts                — used by finish-job-creation only
src/utils/graph-renderer.ts             — used by render-graph only
src/utils/node-validation.ts            — used by node tools only
src/utils/output-schema-blueprint.ts    — used by node tools only
```

### Step 0.5: Delete job-related schema files (1 file)

```
src/shared/schemas/output-schema-blueprint.schema.ts
```

### Step 0.6: Delete job-related tests (12 files)

```
tests/integration/jobs/job-execution-e2e.test.ts
tests/integration/jobs/ai-job-pipeline-e2e.test.ts
tests/integration/jobs/ai-job-creation-e2e.test.ts
tests/integration/jobs/job-creation-mode.test.ts
tests/integration/jobs/job-completion-event.test.ts
tests/integration/jobs/clear-job-graph.test.ts
tests/integration/jobs/dynamic-schema-agent-node.e2e.test.ts
tests/integration/jobs/remove-node-cleanup.test.ts
tests/integration/jobs/litesql-reader-node-execution.test.ts
tests/integration/jobs/litesql-node-schema-enforcement.test.ts
tests/integration/jobs/litesql-node-execution.test.ts
tests/integration/jobs/disconnect-nodes.test.ts
tests/integration/jobs/connect-nodes-validation.test.ts
tests/integration/jobs/add-python-code-node.test.ts
tests/integration/jobs/add-agent-node.test.ts
tests/unit/agent-node-tool-pool.test.ts
tests/unit/ascii-graph.test.ts
tests/unit/graph.test.ts
tests/unit/output-schema-blueprint.test.ts
```

### Step 0.7: Update `src/tools/index.ts`

**Remove exports**: `addJobTool`, `editJobTool`, `createRemoveJobTool`, `getJobsTool`, `getNodesTool`, `clearJobGraphTool`, `createRunJobTool`, `finishJobTool`, `createEditNodeTool`, `removeNodeTool`, `connectNodesTool`, `disconnectNodesTool`, `setEntrypointTool`, `addNodeTestTool`, `runNodeTestTool`, `setJobScheduleTool`, `removeJobScheduleTool`, `createRenderGraphTool`, `createStartJobCreationTool`, `createAddCurlFetcherNodeTool`, `createAddRssFetcherNodeTool`, `createAddCrawl4aiNodeTool`, `createAddSearxngNodeTool`, `createAddPythonCodeNodeTool`, `createAddOutputToAiNodeTool`, `createAddAgentNodeTool`, `createAddLitesqlNodeTool`, `createAddLitesqlReaderNodeTool`, `createFinishJobCreationTool`, `createCreateOutputSchemaTool`, `JobActivityTracker`, `IJobActivityTracker`, `IJobCreationModeTracker`, `IJobCreationMode`

**Keep all other exports** (cron, knowledge, think, commands, files, messaging, prompts, skills, database, web).

### Step 0.8: Update `src/agent/main-agent.ts`

**Remove imports**:
- `BrainInterfaceService` from `../brain-interface/service.js`
- `JobActivityTracker` from `../utils/job-activity-tracker.js`
- All job tool imports (`addJobTool`, `editJobTool`, etc.)
- All node creation tool imports (`createAddCurlFetcherNodeTool`, etc.)
- `PROMPT_JOB_CREATION_GUIDE` from `../shared/constants.js`

**Remove from session interface (`IChatSession`)**:
- `jobCreationMode: IJobCreationMode | null`

**Remove from `initializeForChatAsync`**:
- Job tool registrations (lines ~357-365 for conditional job tools)
- Node creation tools construction (lines ~383-408)
- `jobCreationGuide` prompt loading
- `jobCreationMode` initialization
- `getMode` / `markAudit` functions

**Remove from `_buildAgent`**:
- `nodeCreationTools` parameter and binding
- `jobCreationGuide` system prompt injection
- `jobCreationMode` getter

**Remove from session save/load**:
- `jobCreationMode` serialization

**Remove BrainInterface emission calls**:
- `brainInterface.emitStepStartedAsync`
- `brainInterface.emitToolCalledAsync`
- `brainInterface.emitToolResultAsync`
- `brainInterface.emitGraphUpdatedAsync`
- `brainInterface.emitModelOutputAsync`
- `_emitGraphUpdateAsync` function

**Remove `_emitGraphUpdateAsync` helper function entirely**.

**Update `processMessageForChatAsync`**:
- Remove `jobCreationMode` from tool filtering logic
- Simplify tool registry check (no `jobCreationEnabled`)

### Step 0.9: Update `src/agent/system-prompt.ts`

**Remove**:
- `jobCreation.enabled` condition block
- Job creation tool listing in system prompt

### Step 0.10: Update `src/helpers/tool-registry.ts`

**Remove**:
- `JOB_CREATION_TOOLS` Set and all references
- `jobCreationEnabled` from `IToolFilterOptions`
- `jobCreationEnabled` check in `isToolAllowed`
- Job creation tools from `getCoreToolNames`

### Step 0.11: Update `src/shared/constants.ts`

**Remove**:
- `JOB_FILE_NAME`
- `PROMPT_JOB_AGENT`
- `PROMPT_AGENT_NODE_GUIDE`
- `PROMPT_JOB_CREATION_GUIDE`

### Step 0.12: Update `src/shared/types/config.types.ts`

**Remove**:
- `IJobCreationConfig` interface
- `IBrainInterfaceConfig` interface
- `jobCreation` from `IConfig`
- `brainInterface` from `IConfig`

### Step 0.13: Update `src/shared/schemas/config.schemas.ts`

**Remove**:
- `jobCreationConfigSchema`
- `brainInterfaceConfigSchema`
- References in main config schema

### Step 0.14: Update `src/shared/schemas/tool-schemas.ts`

**Remove**:
- `graph-audit` from `PROMPT_NAMES` list
- `job-creation-guide` from `PROMPT_NAMES` list
- `job-agent` from `PROMPT_NAMES` list
- All job tool input/output schemas

### Step 0.15: Update `src/shared/schemas/index.ts`

**Remove**:
- `output-schema-blueprint.schema` re-export

### Step 0.16: Update `src/index.ts`

**Remove imports**:
- `BrainInterfaceService` from `./brain-interface/service.js`
- `getJobLogsDir`, `getBrainInterfaceTokenFilePath` (if not used elsewhere)

**Remove initialization**:
- `JobStorageService.initializeAsync` call
- `JobExecutorService` initialization
- `BrainInterfaceService.getInstance()` and `.initialize()`
- BrainInterface JWT generation and token file writing
- BrainInterface WebSocket server startup
- `BRAIN_INTERFACE_PORT` constant
- `getJobLogsDir()` usage in cron logging

**Keep**: Everything else — cron scheduler, Telegram, Discord, MCP, embeddings, vector store, etc.

### Step 0.17: Update `src/utils/paths.ts`

**Remove**:
- `getJobLogsDir()` function
- `getBrainInterfaceTokenFilePath()` function
- `getJobLogsDir()` from `ensureAllDirectoriesAsync`

### Step 0.18: Update `src/agent/cron-agent.ts`

**Remove imports**:
- `JobActivityTracker` (used at line 285)
- `jobTracker` creation (line 285)

### Step 0.19: Update `vitest.config.ts`

**Remove**:
- `tests/integration/jobs/**/*.test.ts` from include list

### Step 0.20: Delete `tests/integration/jobs/` directory

```
rm -rf tests/integration/jobs/
```

### Step 0.21: Delete `src/brain-interface/` directory

```
rm -rf src/brain-interface/
```

### Verification

```bash
pnpm typecheck
pnpm test:unit
pnpm test:core
```

### Files that stay unchanged

**Tools (42 non-job tools)**:
- `src/tools/think.tool.ts`
- `src/tools/run-cmd.tool.ts`, `run-cmd-input.tool.ts`, `get-cmd-status.tool.ts`, `get-cmd-output.tool.ts`, `wait-for-cmd.tool.ts`, `stop-cmd.tool.ts`
- `src/tools/read-file.tool.ts`, `read-image.tool.ts`, `write-file.tool.ts`, `append-file.tool.ts`, `edit-file.tool.ts`
- `src/tools/search-knowledge.tool.ts`, `add-knowledge.tool.ts`, `edit-knowledge.tool.ts`
- `src/tools/send-message.tool.ts`, `get-previous-message.tool.ts`
- `src/tools/modify-prompt.tool.ts`, `list-prompts.tool.ts`
- `src/tools/add-cron.tool.ts`, `remove-cron.tool.ts`, `list-crons.tool.ts`, `get-cron.tool.ts`, `edit-cron.tool.ts`, `edit-cron-instructions.tool.ts`, `run-cron.tool.ts`
- `src/tools/searxng.tool.ts`, `crawl4ai.tool.ts`, `fetch-rss.tool.ts`
- `src/tools/list-databases.tool.ts`, `list-tables.tool.ts`, `get-table-schema.tool.ts`, `create-database.tool.ts`, `create-table.tool.ts`, `drop-table.tool.ts`, `query-database.tool.ts`, `read-from-database.tool.ts`, `write-to-database.tool.ts`, `update-database.tool.ts`, `delete-from-database.tool.ts`
- `src/tools/call-skill.tool.ts`, `get-skill-file.tool.ts`, `setup-skill.tool.ts`

**Services (keep)**:
- `src/services/scheduler.service.ts`, `cron-scheduler.ts`, `cron-message-history.service.ts`
- `src/services/messaging.service.ts`, `config.service.ts`, `logger.service.ts`
- `src/services/embedding.service.ts`, `vector-store.service.ts`, `skill-loader.service.ts`
- `src/services/mcp.service.ts`, `mcp-registry.service.ts`
- `src/services/ai-provider.service.ts` (will be partially rewritten in Phase 1)
- `src/services/channel-registry.service.ts`, `command-detector-linux.service.ts`, `command-process.service.ts`
- `src/services/factory-reset.service.ts`, `model-info.service.ts`, `model-profile.service.ts`
- `src/services/prompt.service.ts`, `rate-limiter.service.ts`, `status.service.ts`
- `src/services/tool-hot-reload.service.ts`

**Utilities (keep)**:
- `src/utils/per-table-tools.ts` (used by cron, scheduler, main-agent)
- `src/utils/json-schema-to-zod.ts` (used by MCP service)
- `src/utils/cron-tool-context.ts` (used by cron scheduler)
- `src/utils/cron-format.ts`
- `src/utils/paths.ts` (after removing job/brain-interface functions)
- `src/utils/*` — all non-job utilities

---

## Phase 1: LangChain Foundation

**Goal**: DeepAgents agent running with 5 proof-of-concept tools, wired to Telegram.
**Branch**: `langchain-migration` (from `main` after Phase 0 is merged).

### Step 1.1: Install dependencies

```bash
pnpm add deepagents langchain @langchain/core @langchain/openai \
  @langchain/langgraph @langchain/langgraph-checkpoint-sqlite \
  @langchain/mcp-adapters
```

### Step 1.2: Create model factory

**New file**: `src/services/langchain-model.service.ts`

```typescript
import { ChatOpenAI } from "@langchain/openai";
import type { IAiConfig } from "../shared/types/config.types.js";

export function createChatModel(config: IAiConfig): ChatOpenAI {
  return new ChatOpenAI({
    model: config.model,
    configuration: {
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    },
    temperature: 0.7,
    maxRetries: 3,
  });
}

export function createFallbackChatModel(config: IAiConfig): ChatOpenAI | null {
  if (!config.fallback?.baseURL || !config.fallback?.model) return null;
  return new ChatOpenAI({
    model: config.fallback.model,
    configuration: {
      baseURL: config.fallback.baseURL,
      apiKey: config.fallback.apiKey,
    },
    temperature: 0.7,
    maxRetries: 2,
  });
}
```

### Step 1.3: Create checkpointer factory

**New file**: `src/services/checkpointer.service.ts`

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { Database } from "better-sqlite3";

export function createCheckpointer(db: Database): SqliteSaver {
  const saver = new SqliteSaver(db);
  saver.setup(); // Creates tables if needed
  return saver;
}
```

### Step 1.4: Create agent factory

**New file**: `src/agent/langchain-agent.ts`

```typescript
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createChatModel } from "../services/langchain-model.service.js";
import type { IAiConfig } from "../shared/types/config.types.js";

export function createChatAgent(config: IAiConfig, tools: Tool[], systemPrompt: string, checkpointer: SqliteSaver) {
  const model = createChatModel(config);
  return createDeepAgent({
    model,
    tools,
    system: systemPrompt,
    checkpointer,
  });
}
```

### Step 1.5: Migrate 5 proof-of-concept tools

Convert from Vercel AI `tool()` to LangChain `tool()`:

| Tool | Current | LangChain |
|------|---------|-----------|
| `think` | `tool({ description, inputSchema, execute })` | `tool(execute, { name, description, schema })` |
| `read_file` | Same | Same |
| `write_file` | Same | Same |
| `run_cmd` | Same | Same |
| `search_knowledge` | Same | Same |

**Conversion pattern** (same Zod schema, same logic):

```typescript
// Before (Vercel AI)
import { tool } from "ai";
export const thinkTool = tool({
  description: "...",
  inputSchema: thinkToolInputSchema,
  execute: async ({ thought }) => { ... },
});

// After (LangChain)
import { tool } from "langchain";
export const thinkTool = tool(
  async ({ thought }) => { ... },
  {
    name: "think",
    description: "...",
    schema: thinkToolInputSchema,
  }
);
```

### Step 1.6: Wire to Telegram handler

**File**: `src/platforms/telegram/handler.ts`

Replace:
```typescript
const result = await mainAgent.processMessageForChatAsync(chatId, text, images);
```

With:
```typescript
const messages = buildLangChainMessages(text, images);
const result = await agent.invoke(
  { messages },
  { configurable: { thread_id: chatId } }
);
```

### Step 1.7: Update `src/index.ts`

- Initialize `SqliteSaver` with existing `better-sqlite3` database
- Create agent via factory
- Pass to Telegram handler

### Verification

```bash
pnpm typecheck
pnpm test:core
# Manual: Send a Telegram message, verify agent responds with tool calls
```

---

## Phase 2: Tool Migration

**Goal**: Convert all 42 remaining tools to LangChain `tool()` format.
**Files modified**: All tool files in `src/tools/`

### Files becoming obsolete (reference Phase 5 for deletion)

- `src/tools/langchain-poc-tools.ts` — absorbed into original tool files once they are converted

### Conversion pattern (mechanical)

For each tool file:

1. Change import: `import { tool } from "ai"` → `import { tool } from "langchain"`
2. Change export: `export const myTool = tool({ description, inputSchema, execute })` → `export const myTool = tool(execute, { name, description, schema: inputSchema })`
3. Change factory: `export const createMyTool = (deps) => tool({ ... })` → `export const createMyTool = (deps) => tool(execute, { ... })`
4. Keep: Zod schemas, logic, error handling

### Tools by category (in migration order)

1. **Thinking** (1 tool)
   - `src/tools/think.tool.ts`

2. **Filesystem** (5 tools)
   - `src/tools/read-file.tool.ts`
   - `src/tools/read-image.tool.ts`
   - `src/tools/write-file.tool.ts`
   - `src/tools/append-file.tool.ts`
   - `src/tools/edit-file.tool.ts`

3. **Commands** (6 tools)
   - `src/tools/run-cmd.tool.ts`
   - `src/tools/run-cmd-input.tool.ts`
   - `src/tools/get-cmd-status.tool.ts`
   - `src/tools/get-cmd-output.tool.ts`
   - `src/tools/wait-for-cmd.tool.ts`
   - `src/tools/stop-cmd.tool.ts`

4. **Knowledge** (3 tools)
   - `src/tools/search-knowledge.tool.ts`
   - `src/tools/add-knowledge.tool.ts`
   - `src/tools/edit-knowledge.tool.ts`

5. **Cron** (7 tools)
   - `src/tools/add-cron.tool.ts`
   - `src/tools/remove-cron.tool.ts`
   - `src/tools/list-crons.tool.ts`
   - `src/tools/get-cron.tool.ts`
   - `src/tools/edit-cron.tool.ts`
   - `src/tools/edit-cron-instructions.tool.ts`
   - `src/tools/run-cron.tool.ts`

6. **Web** (3 tools)
   - `src/tools/searxng.tool.ts`
   - `src/tools/crawl4ai.tool.ts`
   - `src/tools/fetch-rss.tool.ts`

7. **Database** (11 tools)
   - `src/tools/list-databases.tool.ts`
   - `src/tools/list-tables.tool.ts`
   - `src/tools/get-table-schema.tool.ts`
   - `src/tools/create-database.tool.ts`
   - `src/tools/create-table.tool.ts`
   - `src/tools/drop-table.tool.ts`
   - `src/tools/query-database.tool.ts`
   - `src/tools/read-from-database.tool.ts`
   - `src/tools/write-to-database.tool.ts`
   - `src/tools/update-database.tool.ts`
   - `src/tools/delete-from-database.tool.ts`

8. **Messaging** (2 tools)
   - `src/tools/send-message.tool.ts`
   - `src/tools/get-previous-message.tool.ts`

9. **Prompts** (2 tools)
   - `src/tools/modify-prompt.tool.ts`
   - `src/tools/list-prompts.tool.ts`

10. **Skills** (3 tools)
    - `src/tools/call-skill.tool.ts`
    - `src/tools/get-skill-file.tool.ts`
    - `src/tools/setup-skill.tool.ts`

### Update `src/tools/index.ts`

- Change all tool re-exports to use LangChain types
- Remove any remaining Vercel AI SDK imports

### Verification

```bash
pnpm typecheck
pnpm test:unit
pnpm test:core
```

---

## Phase 3: Session + Persistence Migration

**Goal**: Replace custom session management with LangGraph checkpointer.
**Remove**: JSON file sessions, custom serialization, in-memory session Map.

### Files becoming obsolete (reference Phase 5 for deletion)

- `src/agent/main-agent.ts` — session logic replaced by checkpointer
- `src/utils/prepare-step.ts` — prepareStep logic handled by DeepAgents internally

### Step 3.1: Write session migration script

**New file**: `scripts/migrate-sessions.ts`

```typescript
// Reads ~/.blackdogbot/sessions/*.json
// Converts ModelMessage[] → LangChain BaseMessage[]
// Writes to SqliteSaver as initial checkpoint
// Strategy: < 7 days = migrate, 7-30 days = summarize, > 30 days = skip
```

### Step 3.2: Create message converter

**New file**: `src/utils/message-converter.ts`

```typescript
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

export function convertVercelToLangChain(vercelMessages: ModelMessage[]): BaseMessage[];
export function convertLangChainToVercel(langChainMessages: BaseMessage[]): ModelMessage[];
```

### Step 3.3: Update `src/agent/langchain-agent.ts`

- Remove `MainAgent._sessions` Map entirely
- Each `agent.invoke()` uses `{ configurable: { thread_id: chatId } }`
- Checkpointer handles persistence automatically
- Remove `_saveSessionAsync`, `_loadSessionAsync`
- Remove custom JSON serialization (`replacer`, `reviver`)

### Step 3.4: Update Telegram handler

- Replace `mainAgent.initializeForChatAsync(chatId)` — no longer needed
- Replace `mainAgent.processMessageForChatAsync(chatId, text, images)` — just `agent.invoke()`
- Session state managed by checkpointer

### Step 3.5: Update Discord handler

- Same pattern as Telegram

### Files modified

```
src/agent/langchain-agent.ts          — agent factory (new)
src/agent/main-agent.ts               — DELETE (replaced by langchain-agent.ts)
src/platforms/telegram/handler.ts     — updated invoke pattern
src/platforms/discord/handler.ts      — updated invoke pattern
src/utils/message-converter.ts        — new file
scripts/migrate-sessions.ts           — new migration script
```

### Files deleted

```
src/agent/main-agent.ts               — full replacement
```

### Verification

```bash
pnpm typecheck
pnpm test:core
# Manual: Verify sessions persist across restarts
# Manual: Run migration script on existing sessions
```

---

## Phase 4: MCP Integration Migration

**Goal**: Replace custom MCP service with `@langchain/mcp-adapters`.
**Remove**: `src/services/mcp.service.ts` (custom MCP client with Vercel AI tool conversion).

### Files becoming obsolete (reference Phase 5 for deletion)

- `src/services/mcp.service.ts` — replaced by `langchain-mcp.service.ts`

### Step 4.1: Replace `mcp.service.ts`

**New file**: `src/services/langchain-mcp.service.ts`

```typescript
import { loadMcpTools } from "@langchain/mcp-adapters";
import { McpRegistryService } from "./mcp-registry.service.js";

export class LangchainMcpService {
  async loadToolsAsync(): Promise<Tool[]> {
    const servers = this._registry.listServers();
    const tools: Tool[] = [];
    for (const server of servers) {
      const serverTools = await loadMcpTools(server.id, {
        command: server.command,
        args: server.args,
      });
      tools.push(...serverTools);
    }
    return tools;
  }
}
```

### Step 4.2: Delete `mcp.service.ts`

### Step 4.3: Update agent factory

- Merge MCP tools into agent's tool set at creation time

### Files modified

```
src/services/langchain-mcp.service.ts  — new file (replaces mcp.service.ts)
src/services/mcp.service.ts            — DELETE
src/agent/langchain-agent.ts           — integrate MCP tools
```

### Verification

```bash
pnpm typecheck
pnpm test:core
pnpm test:integration  # MCP tests
```

---

## Phase 5: Remove Old Agent Code + Dependencies

**Goal**: Delete all Vercel AI SDK agent code, old utilities, old dependencies.

### Files becoming obsolete — DELETED IN THIS PHASE

All files listed in Steps 5.1-5.3 are deleted in this phase.

### Step 5.1: Delete old agent files

```
src/agent/base-agent.ts                — replaced by DeepAgents
src/agent/main-agent.ts                — replaced by langchain-agent.ts (deleted in Phase 3)
src/agent/cron-agent.ts                — replaced by DeepAgents subagent
```

### Step 5.2: Delete old utilities

```
src/utils/summarization-compaction.ts  — replaced by DeepAgents SummarizationMiddleware
src/utils/request-token-counter.ts     — replaced by LangChain callbacks
src/utils/token-tracker.ts             — replaced by LangChain callbacks
src/utils/llm-retry.ts                 — replaced by .withRetry()
src/utils/tool-call-repair.ts          — replaced by LangChain validation
src/utils/tool-reasoning-wrapper.ts    — replaced by DeepAgents middleware
src/utils/image-token-estimator.ts     — replaced by LangChain fixed 85 tokens/image
src/utils/prepare-step.ts              — replaced by DeepAgents internals
src/utils/llm-call-context.ts          — replaced by LangChain callbacks
src/utils/tool-call-tracker.ts         — replaced by LangChain callbacks
```

### Step 5.3: Delete old test files

```
tests/integration/core/base-agent.test.ts
tests/integration/core/summarization-compaction.dag.e2e.test.ts
tests/unit/request-token-counter.test.ts
tests/unit/token-tracker.image-estimation.test.ts
tests/unit/summarization-compaction.dag.test.ts
tests/unit/summarization-compaction.forced.test.ts
tests/unit/summarization-compaction.task-aware.test.ts
tests/unit/llm-retry.test.ts
tests/unit/tool-call-repair.test.ts
```

### Step 5.4: Remove old dependencies from `package.json`

```bash
pnpm remove ai @ai-sdk/openai @ai-sdk/openai-compatible @ai-sdk/provider \
  @openrouter/ai-sdk-provider @lmstudio/sdk js-tiktoken
```

### Step 5.5: Update `src/index.ts`

- Remove `AiProviderService` initialization (replaced by `createChatModel`)
- Simplify boot sequence

### Step 5.6: Simplify config

- Unify AI provider config to single `baseURL` + `model` + `apiKey` structure
- Remove `providers` map, fallback config (use LangChain's built-in fallback)

### Verification

```bash
pnpm typecheck
pnpm test
```

---

## Phase 6: DeepAgents Features

**Goal**: Leverage subagents, planning, filesystem backends, skills.

### Files becoming obsolete (reference Phase 7 for final cleanup)

- `src/agent/cron-agent.ts` — replaced by DeepAgents subagent

### Step 6.1: Define cron subagent

```typescript
const cronSubagent = {
  name: "cron-agent",
  description: "Execute scheduled tasks autonomously",
  systemPrompt: cronAgentPrompt,
  tools: [...cronTools, ...fileTools, ...knowledgeTools, ...webTools],
};
```

### Step 6.2: Wire skills as DeepAgents native skills

```typescript
const agent = createDeepAgent({
  model,
  tools: allTools,
  subagents: [cronSubagent],
  skills: ["/skills/"],  // DeepAgents native skill discovery
  system: mainSystemPrompt,
});
```

### Step 6.3: Configure CompositeBackend

```typescript
import { CompositeBackend, StateBackend, StoreBackend } from "deepagents";

const backend = (rt) => new CompositeBackend({
  default: new StateBackend(rt),           // /workspace/* — ephemeral
  routes: {
    "/memories/": new StoreBackend(rt),     // /memories/* — persistent cross-thread
  },
});

const agent = createDeepAgent({
  model,
  tools,
  checkpointer,
  store,         // LangGraph Store for StoreBackend
  backend,
});
```

### Step 6.4: Remove `SchedulerService` cron job execution from `src/index.ts`

Replace direct `cronAgent.executeTaskAsync` with:
```typescript
const result = await agent.invoke({
  messages: [{ role: "user", content: cronTaskPrompt }],
}, {
  configurable: { thread_id: `cron-${taskId}` },
});
```

### Files modified

```
src/agent/langchain-agent.ts    — subagents, skills, backend config
src/services/scheduler.service.ts — subagent invocation
src/index.ts                    — simplified boot
```

### Files deleted

```
src/agent/cron-agent.ts         — replaced by subagent (if not already deleted in Phase 5)
```

### Verification

```bash
pnpm typecheck
pnpm test
# Manual: Test cron task execution via subagent
# Manual: Test skill discovery
```

---

## Phase 7: Final Hardening

### Step 7.1: Scan for accidental old code

Before merging, search the codebase for any references to deleted modules or dead imports:

```bash
# Check for references to deleted files/modules
rg "from.*ai'" src/ --include '*.ts'           # Vercel AI SDK imports
rg "from.*@ai-sdk" src/ --include '*.ts'        # AI SDK packages
rg "from.*@openrouter" src/ --include '*.ts'    # OpenRouter AI SDK
rg "from.*@lmstudio" src/ --include '*.ts'      # LM Studio SDK
rg "from.*js-tiktoken" src/ --include '*.ts'    # Tiktoken
rg "JobStorageService" src/ --include '*.ts'    # Deleted service
rg "JobExecutorService" src/ --include '*.ts'   # Deleted service
rg "BrainInterface" src/ --include '*.ts'       # Deleted WebSocket
rg "base-agent" src/ --include '*.ts'           # Deleted agent base
rg "cron-agent" src/ --include '*.ts'           # Deleted cron agent
rg "jobCreation" src/ --include '*.ts'          # Deleted config
rg "nodeCreation" src/ --include '*.ts'         # Deleted tools

# Fix any found references
# Remove dead imports, update to LangChain equivalents
```

### Step 7.2: Full test suite

```bash
pnpm typecheck
pnpm test
pnpm test:integration
```

### Step 7.2: Lint

```bash
# Add any lint scripts if applicable
```

### Step 7.3: Update documentation

- Update README.md with new architecture
- Update config examples

### Step 7.4: Merge

```bash
git checkout main
git merge langchain-migration
git push
```

---

## Summary: Files Affected Per Phase

| Phase | Files Created | Files Deleted | Files Modified |
|-------|--------------|---------------|----------------|
| 0: Jobs Removal | 0 | ~48 | ~12 |
| 1: LangChain Foundation | 3 | 0 | ~5 |
| 2: Tool Migration | 0 | 0 | ~42 |
| 3: Session Migration | 2 | 1 | ~5 |
| 4: MCP Migration | 1 | 1 | ~2 |
| 5: Old Code Cleanup | 0 | ~20 | ~3 |
| 6: DeepAgents Features | 0 | 1 | ~3 |
| 7: Hardening | 0 | 0 | ~2 |
| **Total** | **~6** | **~71** | **~72** |

## Summary: Custom Code Removed

| Category | Lines |
|----------|-------|
| Jobs system | ~4,000 |
| Agent loop + session management | ~2,200 |
| Compaction system | ~1,200 |
| Token tracking | ~800 |
| Retry/repair logic | ~400 |
| MCP integration (custom) | ~460 |
| Old dependencies | N/A |
| **Total** | **~9,000+ lines** |
