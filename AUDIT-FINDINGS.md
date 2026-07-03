# Codebase Audit Findings

> Generated from full impl-check across 7 sections (42 lane reviews)
> 174 source files + 114 test files reviewed

---

## Critical (4)

### C1 — `utils/json-schema-to-zod.ts:43` — `normalizeStrictObjectSchema` forces ALL properties required
`normalized.required = Object.keys(normalizedProperties)` unconditionally overwrites the original `required` array. Any JSON Schema that explicitly marks some fields as optional gets all fields forced to required. Silent data model corruption affecting all LLM output schema generation.

### C2 — `utils/json-schema-to-zod.ts:107-124` — `handleUnionType` drops all but first non-null type
`type: ["string", "integer", "null"]` → only `nonNullTypes[0]` processed. Rest silently dropped. No warning or error.

### C3 — `helpers/litesql.ts:377-392, 423, 455` — SQL injection via raw string interpolation
`WHERE ${options.where}`, `ORDER BY ${options.orderBy}`, `DELETE FROM ... WHERE ${where}` — no parameterization. LLM agent can craft `where: "1=1"` to exfiltrate/destroy all rows. `delete_from_database` tool has zero regex guard on WHERE clause.

### C4 — `shared/schemas/config.schemas.ts:278` vs `shared/types/channel.types.ts:12` — Discord permission enum completely disjoint
Schema: `z.enum(["public","private","admin"])` vs Runtime: `type ChannelPermission = "ignore" | "read_only" | "full"`. Config YAML with runtime values crashes startup; schema values never match runtime permission checks.

---

## High (20)

### H1 — `agent/retry-orchestrator.ts` + `agent/main-agent.ts:782` — Context-exceeded retries guaranteed to fail
`onContextExceededCompaction` callback defined in interface but never wired by `_runGenerationCycleAsync`. Retries with same oversized context burn 2 LLM round-trips before fallback.

### H2 — `agent/cron-agent.ts:73-90, 259` — Singleton CronAgent shared mutable state race
`run_timed` tool bypasses scheduler concurrency. Concurrent `executeTaskAsync` calls corrupt `_agent`, token counters, compaction flags.

### H3 — `agent/session-manager.ts:61` — Generic cast `as ParsedSession` lies about return shape
Callers believe they get `IChatSession` fields from disk but only get `IPersistedSession` fields (`messages` + `lastActivityAt`).

### H4 — `agent/main-agent.ts:624` — Null check after property access (dead code)
`result.text.trim() && result !== null` — if result were null, throws before reaching check.

### H5 — `services/command-process.service.ts:110` — `spawn(command, [], { shell: true })`
Caller-provided command string passed through shell interpreter with empty args array.

### H6 — `services/vector-store.service.ts:152, 193, 218, 229` — SQL injection in LanceDB predicates
`query.where(\`collection = '${collectionFilter}'\`)` — unescaped string interpolation into SQL-like predicates.

### H7 — `services/factory-reset.service.ts:6` — Services layer imports MainAgent (inverted dependency)
`import { MainAgent } from "../agent/main-agent.js"` — services reaching into agent layer.

### H8 — `tools/add-once.tool.ts:47` + `tools/edit-once.tool.ts:116-124` — Timezone ignored in runAt computation
`new Date(year, month-1, ...)` uses server local timezone, ignoring configured `scheduler.timezone`.

### H9 — `tools/stop-cmd.tool.ts:21` — Signal schema accepts any string
`z.string().default("SIGTERM")` — no enum constraint. Cast to `"SIGTERM" | "SIGKILL" | "SIGINT"` is unsound.

### H10 — `tools/get-skill-file.tool.ts:27` — Path traversal
`path.join(getSkillDir(skillName), filePath)` — no validation against `../` sequences.

### H11 — `helpers/skill-installer.ts:173-254` — Shell command injection via skill package names
`brew install ${formula}`, `npm install -g ${pkg}` — skill metadata interpolated into shell commands.

### H12 — `helpers/dependency-checker.ts:40-41, 113-119` — Shell injection + anyBins logic bug
`` `which ${bin}` `` — no validation. `anyBins` alternatives checked individually instead of as group.

### H13 — `utils/llm-retry.ts:371-373` — Blind `as z.infer<T>` cast without Zod validation
`return { object: input as z.infer<T> }` — unsound cast in execute handler.

### H14 — `utils/node-validation.ts:67` — Dead ternary: both branches are `"HEAD"`
`method === "HEAD" ? "HEAD" : "HEAD"` — configured `method: "GET"` silently ignored.

### H15 — `utils/file-tools-helper.ts:64-69` — Path traversal via absolute paths
`if (path.isAbsolute(trimmed)) return trimmed` — no sandbox, can access any filesystem path.

### H16 — `utils/paths.ts:6` ↔ `helpers/litesql.ts:6` — Circular dependency
`paths.ts` → `litesql.ts` → `paths.ts` — module cycle.

### H17 — `tools/run-timed.tool.ts:4` → `agent/cron-agent.ts:13-45` — Circular dependency
Tools layer imports from agent, agent imports from tools.

### H18 — `shared/schemas/tool-schemas.ts:826-828` — `fetchRssToolInputSchema.url` no `.url()` validation
Any string passes, enabling SSRF via `fetch(url)`. Compare with `crawl4aiToolInputSchema.url` which uses `z.string().url()`.

### H19 — `utils/tool-reasoning-wrapper.ts:77` — `as never` cast erases all type safety
`return execute(sanitizedInput as never, options)` — complete type erasure.

### H20 — `utils/token-tracker.ts:238` — Double cast `as unknown as Record<string, unknown>`
Defeats purpose of typed `ImagePart` parameter.

---

## Medium (42)

### M1 — `agent/base-agent.ts` + `agent/retry-orchestrator.ts` — Duplicated retry logic
Two full retry loops with identical constants. CronAgent uses base-agent path, MainAgent uses orchestrator.

### M2 — `agent/tool-assembly.ts` + `agent/cron-agent.ts:295-417` — Duplicated tool assembly
CronAgent rebuilds entire tool map from scratch instead of using `assembleToolsForChat`.

### M3 — `services/ai-provider.service.ts:416` — Sync `initialize()` skips model profile init
Profile-driven behavior silently disabled when sync path used.

### M4 — `services/scheduler.service.ts:730` — Closure captures task by mutable reference
Race window on reschedule where stale closure executes with pre-patch data.

### M5 — `services/vector-store.service.ts:184` — Non-atomic delete-then-add
Window where record is invisible to concurrent readers.

### M6 — `services/command-detector-linux.service.ts:157-163` — Exit handler races with startAsync return
Stale handle returned to caller.

### M7 — `services/config.service.ts:60` — `getConfig()` returns mutable internal reference
Any caller can corrupt config without `updateConfigAsync`.

### M8 — `services/mcp.service.ts:356, 375, 397-415` — Multiple `as any` casts
Silencing type system on MCP tool conversion and result parsing.

### M9 — `services/embedding.service.ts:328, 358, 394` — Unsafe pipeline output cast
`{ tolist(): number[][] }` cast on transformers output — no shape validation.

### M10 — `services/telegram-outbox.service.ts:129` — Unsafe SQLite row type cast
Single point of failure between database and typed service.

### M11 — `services/cron-message-history.service.ts:16-18` — Hardcoded context window values
`128_000` hardcoded — wrong threshold for models with different context sizes.

### M12 — `services/ai-provider.service.ts:1226-1239` — Sequential probes for up to 40 models
Each with 300s timeout — worst case 200 minutes serial blocking.

### M13 — `services/ai-provider.service.ts:1055-1058` — Shallow merge overwrites config subtree
Nested `ai` fields silently dropped if caller passes partial subtree.

### M14 — `services/logger.service.ts:39` + `services/status.service.ts:57` — Raw EventEmitter exposed
Any module can `.removeAllListeners()` or inject events.

### M15 — `services/command-process.service.ts:370-378` — O(n²) buffer growth
`Buffer.concat` on every data event — high memory pressure for long-running processes.

### M16 — `services/skill-loader.service.ts:159-165` — Three identical branches
All call `_determineSkillStateAsync` with same args.

### M17 — `tools/knowledge-tool-factory.ts:82` + `tools/modify-prompt.tool.ts:48` — `(error as Error).message`
Returns `undefined` if thrown value is not Error. 43 other sites use `extractErrorMessage()`.

### M18 — `tools/fetch-rss.tool.ts:91-141` — No try/catch in execute
`fetch()`, `parseRssFeed()`, state load/save can all throw unhandled.

### M19 — `tools/create-table.tool.ts:53-66` — Dead defaultValue detection
Zod `.strict()` already rejects unknown keys, runtime check unreachable.

### M20 — `tools/search-timed.tool.ts:58` — `query` parameter inferred as `any`
No type annotation or default value.

### M21 — `tools/update-table.tool.ts:59` — `input as Record<string, unknown>` bypasses Zod
No runtime validation.

### M22 — `helpers/litesql.ts:350-363` — `tableExistsAsync` swallows all errors
Database corruption misdiagnosed as "table doesn't exist".

### M23 — `utils/llm-retry.ts:88-106` — AbortSignal listener and timeout leak
Listeners accumulate per LLM call on success path.

### M24 — `utils/llm-probe-helpers.ts:95` — `response.json()` outside try/catch
Non-JSON 200 response causes unhandled rejection.

### M25 — `utils/rss-parser.ts:24` — Duplicate XML tags overwrite
RSS items with multiple `<category>` or `<link>` lose all but last.

### M26 — `utils/tool-call-tracker.ts:71` — Fragile fallback name-based matching
Same tool called twice in one step gets results misattributed.

### M27 — `utils/per-table-tools.ts:38-90` vs `96-147` — Near-identical scaffolding
`buildPerTableToolsAsync` and `buildUpdateTableToolsAsync` share ~50 lines.

### M28 — `utils/summarization-compaction.ts:202-407` — God function
`_compactViaDagAsync` is 200+ lines with complex DAG state machine.

### M29 — `utils/llm-retry.ts:125-293` vs `305-575` — 70% identical retry scaffolding
`generateTextWithRetryAsync` and `generateObjectWithRetryAsync` nearly line-for-line identical.

### M30 — `utils/summarization-compaction.ts:1454` vs `utils/llm-retry.ts:112` — Inconsistent token estimation
`text.length / 4` (chars) vs `Buffer.byteLength(text) / 4` (bytes).

### M31 — `shared/schemas/tool-schemas.ts:678-685` — `z.any()` on task field
No validation on full scheduled task shape.

### M32 — `shared/schemas/tool-schemas.ts:693-732` — `z.string()` instead of `z.enum`
`listCronsToolOutputSchema.schedule.type` unvalidated string.

### M33 — `shared/schemas/tool-schemas.ts` — 28 output schemas, only 1 consumed
Dead weight that silently drifts.

### M34 — `shared/schemas/config.schemas.ts` — Magic numbers hardcoded
`600000`, `65536`, `3` instead of referencing `shared/constants.ts`.

### M35 — `shared/schemas/config.schemas.ts:259-261` — JWT secret defaults to known-weak value
`"replace-with-generated-secret"` accepted as valid.

### M36 — `shared/types/config.types.ts` — Manual IConfig drifts from Zod schema
Defaulted fields typed as optional when always present after parse.

### M37 — `shared/types/skill.types.ts:42-52` vs `skill.schemas.ts:81-105` — ISkillFrontmatter maintained separately
Drift risk between type and schema.

### M38 — `utils/llm-retry.ts` — Service disguised as utility
Imports 4 service singletons.

### M39 — `utils/agent-node-tool-pool.ts` — Business logic in utils layer
Imports from services, tools, helpers.

### M40 — `utils/cron-tool-context.ts:10-13` — N+1 tool building
Creates full tool instances just to extract `.description` strings.

### M41 — `helpers/dependency-checker.ts:113-119` — anyBins checked individually
Wrong semantics — should check as a group of alternatives.

### M42 — `helpers/skill-state.ts:20` — Bare catch swallows file corruption
Returns default state, overwrites corrupted file silently.

---

## Low (20)

### L1 — `extractErrorMessage()` exists but 31+ sites inline the pattern
### L2 — `DEFAULT_TIMEOUT_MS = 30000` duplicated in 3 client files
### L3 — Tiktoken encoder cached independently in 2 files
### L4 — Singleton pattern reimplemented in all 21 services instead of `createSingleton`
### L5 — `_normalizeTimeParts` duplicated in 2 cron tool files
### L6 — Timezone validation IIFE duplicated in 4 cron tool files
### L7 — Cron task verification flow duplicated in 3 tools
### L8 — `_buildHistorySliceForAdviser` duplicated in 2 agent files
### L9 — Recursive directory listing duplicated in 2 service files
### L10 — Message splitting logic duplicated in 2 utility files
### L11 — `clearAllChatHistory()` skips file cleanup and hot-reload unregistration
### L12 — `setup-skill.tool.ts` exported but not wired — dead code
### L13 — `wrapCreateTableWithHotReload` exported but never imported — dead code
### L14 — `_currentInputTokensForLegacyLogs` getter has zero callers — dead code
### L15 — `removeCronToolInputSchema`, `removeCronToolOutputSchema` — dead exports
### L16 — `IChatSession` exported with rich internal state — leaks internals
### L17 — `ToolCallSummary` and `TrackedToolCallSummary` — identical interfaces in 2 files
### L18 — Install kind union repeated in 4 locations
### L19 — `ISkillRequirements` and `ISkillMissingDeps` — identical interfaces
### L20 — Schema file naming inconsistent (hyphen vs dot, singular vs plural)

---

## Test Quality (10)

### T1 — 40+ source files have zero test coverage
### T2 — 6 tool tests are "existence smoke tests" only
### T3 — `behavioral-issues.test.ts` matches regex on source text, not behavior
### T4 — False positive in `summarization-compaction.new-features.test.ts:212-255`
### T5 — Tests re-implement production logic inline (`context-overflow.test.ts:291-333`)
### T6 — Extensive `as any` / `as unknown as` in integration tests
### T7 — `TestAgent extends BaseAgentBase` duplicated 4 times
### T8 — `create429Error` helper duplicated verbatim in 2 files
### T9 — `countApprox` and `makeToolMessage` re-implemented locally in 4+ files
### T10 — Hardcoded `CRON_VALID_TOOL_NAMES` in test duplicates source constant
