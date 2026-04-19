# Implementation Plan — 10 Subagent Passes

## Scope of work (user confirmed):
- **SKIP**: SQL injection fix (intentional design), stdin sanitization (intentional), path traversal (intentional)
- **FIX**: 
  - D3: Silent failure — tighten all bare `{ catch {} }` + `as any` fixes
  - C1+E2: Reuse — extract verifier prompt builder, knowledge tool factory, send-message dedup
  - E3: Documentation additions
  - E4: Test fixes (self-fulfilling assertions)
  - God file split (main-agent.ts first, then analyze quality)
  - Singleton analysis (identify non-singleton services that should be singletons)
  - DB authz bypass (add missing tools to READ_ONLY_BLOCKED_TOOLS) + stdin sanitization

## Plan Structure — 10 Subagents (can run in parallel):

---

### Subagent S1: God File Split — MainAgent → SessionManager module
**File:** `src/agent/session-manager.ts`
**Goal:** Extract session lifecycle methods from main-agent.ts into their own module.

What to extract:
- `_saveSessionAsync` (L1193-1214) + IPersistedSession interface (L125-128) + _sessionParseReviver/_sessionStringifyReplacer helpers
- `_loadSessionAsync` (L1216-1238)
- `_normalizeLoadedSessionMessages` (from base-agent.ts or inline — check line references)
- `compactSessionMessagesForChatAsync` method wrapper (L1044-1076)
- `_sessionParseReviver` private function

This new module will export:
- `class SessionManager` with methods: saveSessionAsync(chatId, session), loadSessionAsync(chatId), normalizeLoadedMessages(messages, logger, chatId)
- Keep the compact interface but make it call into _compactSessionMessagesAsync from utils/summarization-compaction.js

The MainAgent will import this new module and use SessionManager.getInstance() or receive it via constructor.

### Subagent S2: God File Split — MainAgent → DuplicateLoopHandler module
**File:** `src/agent/duplicate-loop-handler.ts`
**Goal:** Extract all duplicate tool loop tracking into its own module.

What to extract:
- `_createDuplicateToolLoopCallback` (L1241-1283) + IDuplicateLoopEscalationState interface (L101-104)
- `IDuplicateLoopAction`, `EDuplicateLoopAction` types from base-agent.ts
- `_resetDuplicateLoopEscalation` helper
- `DuplicateLoopAdviserSchema` constant (L150-153)
- `_createDuplicateLoopAdviserPrompt` private function (L157-186)
- The escalation state machine logic in processMessageForChatAsync that checks session.duplicateLoopEscalation

This module will export a `DuplicateLoopHandler` class with methods like: handleLoop(chatId, loopInfo), reset(), getAdvice() etc.

### Subagent S3: God File Split — MainAgent → RetryOrchestrator / GenerateLoop module
**File:** `src/agent/retry-orchestrator.ts` (new file)
**Goal:** Extract the core generate+retry loop from processMessageForChatAsync into its own orchestrator.

What to extract:
- The entire while(true)/for(attempt)/try/catch retry logic from L624-1043 in processMessageForChatAsync
- This includes context-compaction triggers, 429 backoff, generic retry, fallback activation
- `_activateFallbackAndReinitializeAsync` (L1078-1111)

This module will export an `RetryOrchestrator` class and a function like: processAgentLoop(session, tools, chatId) that encapsulates the entire retry/compact/fallback cycle.

### Subagent S4: God File Split — MainAgent → ToolAssembly module
**File:** `src/agent/tool-assembly.ts` (new file) 
**Goal:** Extract tool setup logic from initializeForChatAsync into a dedicated factory.

What to extract:
- The entire tools = {...} block (L323-403) — all 30+ imports, schema building, MCP merging, per-table tools merge
- Permission filtering logic via `isToolAllowed` 
- `_wrapCreateTableWithHotReload` helper if it exists

This module will export a function like: assembleToolsForChat(chatId, platform) → ToolSet that builds the complete filtered tool set. The MainAgent just calls this once.

### Subagent S5: God File Split — MainAgent → AdminControl module
**File:** `src/agent/admin-control.ts` (new file)
**Goal:** Extract pause/resume/stop/steer/clear methods into their own module.

What to extract:
- `pauseChat`, `resumeChat`, `stopChat`, `steerChat`, `clearChatHistory`, `clearAllChatHistory` (L1112-1187)
- These are all session state manipulation methods

This is straightforward — move these 6 simple methods into a dedicated handler class. The MainAgent delegates to this module.

### Subagent S6: Silent Failures — B9 fixes + rss-state.ts validation
**Files:** ai-provider.service.ts (12 bare catches), main-agent.ts L1554 (as any), rss-state.ts L15 (cast without validate)
**Goal:** Fix all silent failure patterns.

Changes:
1. All 12 `{ catch {} }` blocks in ai-provider.service.ts at lines: 271, 1022, 1237, 1401, 1460, 1639, 2430, 2614, 2670, 2795, 3006, 3042 — change each to `catch (e) { if (!(e instanceof SyntaxError)) throw e; }` (narrow to only SyntaxError for JSON.parse contexts).

For the ones wrapping JSON.parse specifically: `try { ...JSON.parse(...)... } catch (e) { if (!(e instanceof SyntaxError)) throw e; }`

2. main-agent.ts line 1554: `clonedMessage.content = normalizedParts as any` — replace with properly typed content using discriminated union from ModelMessage spec. Cast to `string | string[] \| Array<{type: "text", text: string}>`.

3. rss-state.ts line 15: `JSON.parse(content) as IRssState` — add Zod schema validation. Check if an rss schema exists in schemas, if not create one matching IRssState interface and validate before returning.

### Subagent S7: Authz Bypass + Stdin Sanitization
**Files:** tool-registry.ts (READ_ONLY_BLOCKED_TOOLS), run-cmd-input.tool.ts + command-process.service.ts stdin

Changes:
1. Add missing tools to READ_ONLY_BLOCKED_TOOLS set in `src/helpers/tool-registry.ts` line 5-22: add `"delete_from_database"`, `"drop_table"`, and check if `update_table_*` prefix is properly blocked (it's NOT at line 138 — only blocks write_table_). Add `write_table_` already blocked. Need to also block `update_table_*`: update condition on L138-139 to also check `toolName.startsWith('update_table_')`.

2. In command-process.service.ts sendInputAsync (L202-237), sanitize stdin input to strip control characters except newline, carriage return, tab — prevent terminal escape sequence injection via LLM-generated text. Use regex like: `const safe = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')`

### Subagent S8: Reuse/Extractable — Verifier Prompt Builder
**Files:** add-once.tool.ts (L106-155), add-interval.tool.ts (L113-162), edit-instructions.tool.ts (L133-206)

Changes:
1. Create `src/utils/cron-task-verifier.ts` with a function `buildVerifierPromptAsync(toolContextBlock, options)` that:
   - Takes the shared tool context block as input  
   - Accepts per-tool custom rules via `customRules` parameter (add-once has 7 rules, add-interval has 7 with slight tweak to rule 1, edit-instructions has additional Rules 7-8)
   - Returns the complete prompt string

2. Refactor all three tool files to use this builder: pass context block + custom rules array/options and replace inline verifierPrompt with `await buildVerifierPromptAsync(toolContextBlock, options)`

3. Add the per-tool variations as config objects: `{name: 'add-once', customRules: [7, 8]} etc.

### Subagent S9: Reuse/Extractable — Knowledge Tool Factory + Send-Message Dedup
**Files:** add-knowledge.tool.ts, search-knowledge.tool.ts, edit-knowledge.tool.ts (knowledge), send-message.tool.ts (send)

Changes:
1. Create `src/tools/knowledge-tool-factory.ts` with a generic factory that reduces all 3 knowledge tools to ~5-line calls:
```ts
export const addKnowledgeTool = createKnowledgeTool({name, description, inputSchema, executeFn});
export const searchKnowledgeTool = ...;
export const editKnowledgeTool = ...;
```

Factory handles common try/catch + extractErrorMessage pattern.

2. Refactor `src/tools/send-message.tool.ts`: merge `createSendMessageTool` and `createSendMessageToolWithHistory` into single factory:
```ts
export function createSendMessageTool(
  sender: MessageSender, 
  options?: { trackHistory?: boolean; taskIdProvider?: TaskIdProvider; context?: IExecutionContext }
) {
  // Common boilerplate + conditional history dispatch
}
```

### Subagent S10: Tests & Docs
**Files:** search-timed.tool.test.ts (self-fulfilling assertion), any key missing JSDoc methods, config.schemas.ts doc additions

Changes:
1. Fix self-fulfilling assertion in tests/unit/tools/search-timed.tool.test.ts — replace mock data that asserts its own value with behavioral contracts
2. Check ai-provider.service.ts for 3048+ line method without JSDoc on public methods like probeCapabilities, addFallbackAsync, etc.
3. Check any other key utility functions missing documentation after the god file split

---

## Execution Order:
1-5 → Run in parallel (god file splits)
6-10 → Run in parallel (fixes, reuse, docs/tests)

Total: 10 subagent invocations, each focused on ONE concrete task.
