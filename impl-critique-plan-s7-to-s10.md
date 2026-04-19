# Implementation Plan — S7 through S10

## Summary of completed work (S1–S6):
- **God file splits** (5 subagents extracted from main-agent.ts, reducing it from 1,654 lines to ~906 lines and creating 4 new focused modules)
- **Silent failures fixed** (12 bare `{ catch {} }` blocks narrowed, rss-state.ts validation added, `as any` cast replaced)

## Remaining work — S7 through S10:

---

### Subagent S7: Authz Bypass + Stdin Sanitization
**Goal:** Fix read-only DB mutation bypass and stdin escape sequence injection
**Files affected:**
- `/home/jirka/programy/better-claw/src/helpers/tool-registry.ts` — add missing tools to READ_ONLY_BLOCKED_TOOLS set (lines 5–22), update prefix check at lines 138–139
- `/home/jirka/programy/better-claw/src/services/command-process.service.ts` — sanitize stdin input in sendInputAsync method (~line 202)

**Changes:**
1. Add `"delete_from_database"` and `"drop_table"` to the READ_ONLY_BLOCKED_TOOLS array/set at lines 5–22 so read-only channels cannot execute these destructive operations
2. Update the prefix-based permission check around line 139 to also block `update_table_*` dynamic tools (currently only blocks `write_table_`) — this prevents a bypass via update operations on individual tables
3. In command-process.service.ts sendInputAsync, sanitize LLM-generated input before writing to process stdin: strip non-printable control characters (`[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]`) except newline/tab/CR to prevent terminal escape sequence injection through arbitrary text sent to running processes

---

### Subagent S8: Verifier Prompt Builder Extract
**Goal:** Reduce ~150 lines of duplicated verifierPrompt template literals into a single reusable builder function
**Files affected:**
- `/home/jirka/programy/better-claw/src/tools/add-once.tool.ts` — remove inline ~50-line verifierPrompt, call new builder (lines ~106–155)
- `/home/jirka/programy/better-claw/src/tools/add-interval.tool.ts` — same pattern, verifierPrompt at lines ~113–162
- `/home/jirka/programy/better-claw/src/tools/edit-instructions.tool.ts` — same pattern, verifierPrompt at lines ~133–206
- New file: `src/utils/cron-task-verifier.ts` (create new)

**Changes:**
1. Create `src/utils/cron-task-verifier.ts` exporting `buildVerifierPromptAsync(options)` that accepts a shared tool context block and per-tool custom rules/options, builds the common 7-rule base prompt programmatically, appends task-specific sections (current vs proposed instructions for edit-instructions), and returns the full prompt string
2. Replace all three inline verifierPrompt declarations with function calls passing `{ toolContextBlock, customRules, name }` — add-once has rules 1–7, add-interval tweaks rule 1, edit-instructions adds rules 7–8 and current/proposed sections
3. Each tool file drops from ~150-line verifierPrompt block to a 2–4 line function call

---

### Subagent S9: Knowledge Tool Factory + Send-Message Merge
**Goal:** Reduce three near-identical knowledge tools to factory calls; merge send-message variants into one
**Files affected:**
- `/home/jirka/programy/better-claw/src/tools/add-knowledge.tool.ts` — currently 20 lines, remove boilerplate try/catch+extractErrorMessage pattern (lines 1–20)
- `/home/jirka/programy/better-claw/src/tools/search-knowledge.tool.ts` — similar 22-line file without try/catch but shares inputSchema/type structure (lines 1–22)
- `/home/jirka/programy/better-claw/src/tools/edit-knowledge.tool.ts` — 17 lines with same pattern (lines 1–17)
- `/home/jirka/programy/better-claw/src/tools/send-message.tool.ts` — two function exports at line 18 (`createSendMessageTool`) and line 39 (`createSendMessageToolWithHistory`), merge into single factory
- New file: `src/tools/knowledge-tool-factory.ts` (create new)

**Changes:**
1. Create `knowledge-tool-factory.ts` with a generic factory that wraps the common tool definition pattern (import schema → create Tool object → define execute with try/catch/extractErrorMessage) — each knowledge tool becomes one line: `export const addKnowledgeTool = createKnowledgeTool({name, description, inputSchema, helperFn: knowledge.addDocumentAsync})`
2. In send-message.tool.ts, merge the two exports into a single `createSendMessageTool(sender, options?)` factory where optional `{trackHistory, taskIdProvider, context}` config switches between simple mode and history-tracking mode

---

### Subagent S10: Low-Value Tests + Documentation
**Goal:** Fix self-fulfilling/broken assertions in test files; add missing JSDoc on key public methods
**Files affected:**
- `/home/jirka/programy/better-claw/tests/unit/tools/search-timed.tool.test.ts` — self-fulfilling assertions at lines 47–57, structural checks without behavioral contract verification (full file 310 lines)
- `/home/jirka/programy/better-claw/src/agent/main-agent.ts` — add JSDoc to key public methods (`processMessageForChatAsync`, `initializeForChatAsync`, `processMessageForChatAsync`)
- New file: `src/shared/schemas/rss.schemas.ts` already created in S6, needs minimal test for the schema itself

**Changes:**
1. In search-timed.tool.test.ts:
   - Replace "should exist with correct structure" (line 42) which only checks that object and execute are defined — keep this but add functional tests that verify actual search filtering behavior
   - Fix "should return query in output" (line 56) — the test mocks `getAllTasks` to return empty array, expects `{query: "test query"}` in result. This is self-fulfilling because it asserts a value the mock was set up to produce. Replace with a behavioral contract: verify that search scoring actually matches description similarity (e.g., task named "Morning Report" scores higher for query "report" than for query "xyz")
   - Fix structural-only assertions ("toHaveProperty" at lines 88–95) — add assertions that verify the match structure is derived from actual data transformations, not just present
   - Replace mock-returning-mock-data tests with tests validating merge/filter/score logic in real conditions

2. Add JSDoc to main-agent.ts public methods that describe parameters, return values, side effects and usage: `processMessageForChatAsync`, `initializeForChatAsync`, plus key SessionManager exports from S1 (`saveSessionAsync`, `loadSessionAsync`)

---

## Execution notes (S7–S10):
- All four subagents target completely separate file sets → run in parallel
- S7: tool-registry + command-process service files only
- S8: three tool files one new utils file, no cross-cutting deps  
- S9: two groups of tool files — knowledge tools and send-message, no shared state between groups
- S10: test file is isolated, docs additions in main-agent.ts (which was already split into modules by S1–S5)
- After all four complete: run `npx tsc --noEmit` on each subagent's output individually
