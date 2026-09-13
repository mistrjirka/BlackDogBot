# Handoff — BlackDogBot post-audit fix + guardrail batch (2026-09-12 → 2026-09-13)

Session goal: finish the AI SDK v7 provider-contract + image-pipeline migration,
fix **all** post-audit test failures (baseline: 950 passed / 20 failed), investigate
the Ornith-1.5 llama-server hyperparameters, map the guardrail landscape with
subagents, then commit + push + deploy. **2026-09-13: guardrail batch implemented,
reviewed (4-lane impl-check, findings fixed), committed. Deploy + cleanup pending
(see §7).**

## 1. Mission state

| Item | State |
|---|---|
| Implementer subagent output (v7 provider wrapper + canonical file-parts migration) | ✅ Integrated, gap-fixed, **committed** |
| Full suite (final, 2026-09-13) | ✅ 970/970 (one transient llama-server headers-timeout in the serial run; passed on isolated re-run) |
| `main-agent-e2e` create-table | ✅ Fixed — item 1 (create_table registered in chat), live 3/3 incl. rebuild restart |
| tsconfig typecheck | ✅ `tsc --noEmit` clean |
| Guardrail batch (§7.1 picks 1–6) | ✅ All implemented + tests, committed per phase |
| Review | ✅ 4-lane impl-check (S1) + re-review after fixes (S2); all findings resolved |
| Commit | ✅ 5 commits on top of `94510c1` (see §2) |
| Push to github.com:mistrjirka/BlackDogBot.git | ❌ Pending |
| Deploy (daemon restart + stale cache cleanup) | ❌ Pending — see §6/§7 |
| Delete `/tmp/reqdump.ts` | ❌ Pending (item 6 superseded it) |

## 2. Committed baseline

New on 2026-09-13 (committed, **not yet pushed**): `126f871` (BLACKDOG_LOG_LLM
trace) → `89fc10c` (agent-loop guardrails: dup-loop carve-out, tracker removal,
cache-key v2) → `e0ac7a8` (create_table in chat + hot-reload restart + contract
lint) → `29c08b2` (v7 provider contract parity + image pipeline) → `1aff639`
(chore: ignore .codegraph).

Below: pushed baseline. Newest first: `94510c1` (P5c) → `fb9f451` (P6b) → `8eb81cb` (P6) → `1346944` (P5b)
→ `95cd400` (P5: AI SDK v6→v7) → `84c7eec` (P4b) → `b7b0fe8` (P4) → `2b4b403` (P3:
news skill) → `2c736aa` (P2b) → `4619cdc` (P2a) → `330847e` (P1b) → `ba87c91`
(P1a) → `f31a5fa` (P0). Pre-session base: `c73ac46`.

Standing decisions (do not relitigate): **no langgraph/langchain rewrite**;
`src/utils/summarization-compaction.ts` DAG is the crown jewel (semantics
untouched, only additive image preservation); SQL-injection/`shell:true` are
by design (agent is the trusted principal); scheduling is `once`/`interval`
only; repo uses 2-space indent; pi-lens auto-formatter off (`.pi-lens.json`
committed); all `impl-check-*` agents run on `opencode-go/mimo-v2.5`; **no
subagent model overrides** (defaults only).

## 3. Prior-session uncommitted work (now committed as `29c08b2`, 2026-09-13)

- `src/services/ai-provider/ai-provider-core.ts`
  - Preserve `provider` on the rate-limited model wrapper (was: spread dropped
    it → `stepModel.provider.split` crash in v7 E2E).
  - **Probe fix**: `testStructuredOutputsAsync` now injects
    `reasoning_format:"none"` into the probe when the endpoint supports it —
    mirroring the production fetch wrapper. See §4.1.
  - Error-path log guard: `JSON.parse(init.body)` in the failed-request logger
    wrapped in try/catch (pi-lens STOP, pre-existing latent throw in error path).
- `src/agent/main-agent.ts` — user image attachments now canonical v7
  `{type:"file", data:Uint8Array, mediaType}` (was `{type:"image", image:Buffer}`).
- `src/tools/read-image.tool.ts` — tool output uses canonical file data
  `{type:"file", data:{type:"data",data}, mediaType}` (was `image-data`).
- `src/utils/image-token-estimator.ts` — `MAX_IMAGE_TOKEN_ESTIMATE=4096` cap
  (base64 byte-size estimation was faking ~80k "tokens" and forcing bogus
  compaction); `isImageContentPart` + extractor handle `file` parts. See §4.2.
- `src/utils/summarization-compaction.ts` — L1 preserves newest `ImagePart`/
  `FilePart` when replacing the latest user message; `_isImageContentPart`
  covers `image`+`file` and is used by image detection + old-image dropping.
- `src/utils/token-tracker.ts` — token counting handles `file` parts.
- `tests/unit/image-token-estimator.test.ts` — **new** (4 tests).
- `tests/unit/summarization-compaction.for
...[truncated 8909 chars]ced.test.ts` — +29 lines of L1 image-preservation tests.
- `tests/integration/core/session-persistence.test.ts` — import fixed
  (`PhotoSender` type local, no longer imported from tools index).
- `tests/integration/core/skill-loader.test.ts` — bundled `news-digest` skill
  now in expected results.
- `tests/integration/core/main-agent-unit.test.ts` — prompt wording
  ("exact returned ready name") + adviser-slice test moved to
  `DuplicateLoopHandler`.
- `tests/integration/core/llm-retry-e2e.test.ts` — unchanged (probe fix makes it pass).
- `tests/integration/core/compaction-dag.new-features.e2e.test.ts` — chunked
  test renamed + `exchanges >= 1`; fallback test uses unreachable `targetTokens=1`
  + asserts `converged:false`.
- `tests/integration/core/main-agent-e2e.test.ts` — table test: retry-once,
  explicit "Use the create_table tool" prompt, guarded existence check,
  removed 2 unused imports.

## 4. Root-cause findings

### 4.1 Structured-output probe false positive (production bug — fix applied)
Chain: daemon probes `reasoning_format` OK → probe sends bare
`response_format:json_schema` → llama.cpp accepts → mode=`native_json_schema` →
production wrapper injects `reasoning_format:"none"` into every request →
llama.cpp 400 "Failed to initialize samplers: std::exception" on the combination
(reproduced with curl). Every `generateObject` call (adviser, verifiers) was
broken. Fix: probe sends exactly what production sends. Verified: llm-retry
6/6 on a fresh HOME.

### 4.2 Image pipeline kill (fix applied)
Base64 byte-size estimation (~80k "tokens" for a 239KB JPEG) forced L1
compaction, whose replacement dropped the image (`image:0` in all later
requests). Fix: estimate capped at 4096 + L1 preserves newest ImagePart/FilePart.

### 4.3 `create_table` contract drift (FIXED — commit `e0ac7a8`)
`main-agent.md:39,40,43,63` + the news→table workflow ("do table setup in this
conversation") require `create_table` in chat, but it was **cron-only**
(design comment in `tool-assembly.ts`, `cron-agent.ts`). The model was
correctly reporting a missing tool; 3 different models looked "broken".
Sibling: `update_table_<name>` advertised but only exists post-hot-reload.
**Fix:** `create_table` is now registered in the chat agent
(`wrapCreateTableTool`, shared by chat+cron); a successful create sets
`session.pendingToolRebuild` and awaits `ToolHotReloadService.triggerRebuildAsync`
(which now awaits the rebuild callback), then the run loop restarts
`generate()` with a synthetic "new tool available" user message — bounded by
`MAX_TOOL_REBUILD_RESTARTS`. The synthetic restart message does NOT re-attach
image attachments (`isRebuildRestart`). Verified live: `main-agent-e2e` table
test 3/3 incl. the rebuild restart. A new contract-lint test
(`tests/unit/prompts/main-agent-tool-contract.test.ts`) guards the
prompt↔registered-tools surface against this class of drift.

**Gotcha discovered while typing it (keep in mind):** `ICreateTableRebuildInfo`
lives in a leaf module `src/shared/types/tool-rebuild.types.ts` (re-exported by
`shared/types/index.ts`) — NOT in `tool-assembly.ts`. A type reference to it
through the `main-agent ↔ tool-assembly` import cycle degraded to `never`
during checking. Additionally the run-start `session.pendingToolRebuild = null`
flow-narrows the property to `null` for the rest of the method (TS 5.9 CFA),
so the post-`generate()` read goes through a private accessor
`MainAgent._readPendingToolRebuild` (returns the declared type; a `const`
inherits its initializer's flow type). Don't "simplify" either of these away.

### 4.4 Model-dependent e2e assertions (fixed)
Ornith summarizes 38k→2.2k in one L1 pass → `exchanges>1` / `dagPath>1` were
model assumptions, not code contracts. Chunked test: `>=1`. Fallback test:
unreachable target forces the full L1→…→L6 ladder (observed: L1-L6, 111 tokens).

### 4.5 LangSmith verdict: NO
Cloud SaaS; self-hosted is enterprise-licensed; native SDK path drags in
`@langchain/core` against the standing no-langchain decision; shipping
personal conversations to a cloud conflicts with local-first. OTel door stays
open (AI SDK emits OTel spans; LangSmith/Langfuse accept OTel) — an exporter
config later, not a rewrite. Local substitute: env-gated request/response
JSONL trace (prototype exists at `/tmp/reqdump.ts` — DO NOT commit as-is;
wire it properly behind `BLACKDOG_LOG_LLM` if wanted).

### 4.6 Ornith-1.5 hyperparameters (researched, model card)
General: temp 1.0 / top_p 0.95 / top_k 20 / min_p 0.0 / presence 1.5 / repeat 1.0.
Precise coding: temp 0.6 / same / presence 0.0. Server currently runs the
**coding profile** (see §6); for a general assistant the card says 1.0/1.5.
No model-card guidance on disabling thinking. Not changed — table failure was
the missing tool, not sampling. A/B later only if tool-selection issues appear.

## 5. Guardrail map (3 read-only explore lanes, 2026-09-12 ~22:05–22:21)

```text
 user msg → prepareStep (70%→compact 40%; 85% hard gate→30%; reactive 400/413/422/500)
   → dup-loop detector: last 3 identical non-think steps? → handler:
       1st ForceThink(tools→[think]) | 2nd–3rd +adviser→[STEER] | exhausted→HardStop("/clear")
   → generate(): empty×4→fail+fallback | ctx-exceeded×2→compact+retry | 429×8 | generic×3
   → done. Underneath: token hard-gate (>85%→synthetic 400), 2× timeout retry,
      Bottleneck limiter, fallback-provider chain, probes+cache, DAG breaker→L5–L7.
```

Keep (structural, model-independent): all retries/timeouts/429/rate-limit/
compaction/permissions/fallback chain/token hard-gate/maxSteps 300.
Friction/BS candidates:
1. **Dup-loop detector has no idempotent carve-out** — 3× identical
   `get_cmd_status` polls (a designed pattern) confiscate tools, 4th trip kills
   the run (`prepare-step.ts:37`, signature=name+sorted-args). → exempt
   `get_*`/`list_*`/`wait_for_cmd`.
2. **ThinkOperationTracker is advisory-only** — logs at 30 thinks/100k chars,
   `wasTruncated` hardcoded `false`, run continues (`think-limit.ts:40,60`).
   → enforce or delete.
3. **llama.cpp "66% tool-call failure" content-strip rewrite** — fossilized
   workaround, re-validate on current server (harmless today).
4. **strace deterministic detector fails on this host** (ptrace blocked,
   seen in e2e logs); heuristic fallback carries everything (`run-cmd.tool.ts`).
5. **Capability cache trusts positives forever** — only `false` re-probes
   (§6 deploy notes); stale `native_json_schema` survives until manual delete.
   → version the cache key.
6. Duplication (not a guardrail, maintenance): `RetryOrchestrator`
   (main-agent) vs inline retry in `base-agent.ts` (cron/delegate) overlap.
7. Fossils: `qwen3_5.yaml` profile name under Ornith; LM-Studio self-heal
   unused on this deployment (keep, provider-scoped).
Tool-layer guards verified OK: FileReadTracker (read-before-edit enforced),
channel permissions (chat-only; cron gated by task.tools array — by design),
contract lint MISSING (that's the create_table class — §4.3).
Cron agent: zero advertised-but-unregistered tools (clean).

## 6. Deployment state (as of 22:2x local)

llama-server.service (active): Ornith-1.5-9B-MTP-Q6_K.gguf + mmproj-Ornith-1.5-BF16,
`--ctx-size 140000 --parallel 1 --gpu-layers 99 --flash-attn on --cache-ram 4096
--cache-idle-slots --cache-type-k/v q8_0 --spec-type draft-mtp --spec-draft-n-max 2
--reasoning-format auto --reasoning-budget -1 --temp 0.6 --top-p 0.95 --top-k 20
--min-p 0.0 --repeat-penalty 1.0 --presence-penalty 0.0` (coding profile, §4.6).
Config `~/.blackdogbot/config.yaml`: `model: /home/jirka/models/Ornith-1.5-9B-MTP-Q6_K.gguf`,
`activeProfile: qwen3_5`, `disableThinkingOnStructuredOutput: true`.
Capability cache `~/.blackdogbot/cache/capabilities.json`: key
`openai-compatible:/home/jirka/models/Ornith-1.5-9B-MTP-Q6_K.gguf:http://localhost:2345`
= `native_json_schema` (**stale false positive — delete at deploy**).
blackdogbot.service (active): running OLD code (started 20:01, pre-fixes).

## 7. What was done / what remains

DONE 2026-09-13 (user approved "basically everything" = picks 1–6 + commit/push/deploy):
1. ✅ Guardrail picks: (1) create_table in chat, (2) contract-lint test,
   (3) dup-detector carve-out (`get_*`/`list_*`/`wait_for_cmd` — steps made up
   EXCLUSIVELY of these are exempt; mixed steps still detect),
   (4) ThinkOperationTracker **deleted** (not enforced: it was advisory-only,
   `wasTruncated` hardcoded false, global counter never reset in chat;
   compaction is the structural guard), (5) capability cache keys versioned
   `v2:` + stale-version entries dropped on read (self-heals the stale
   `native_json_schema` false positive), (6) `BLACKDOG_LOG_LLM` JSONL trace
   wired into the production fetch wrapper (`src/services/ai-provider/llm-trace.ts`;
   `true`/`1`/`on` → `~/.blackdogbot/logs/llm-trace.jsonl`, else literal path;
   streaming skipped; response capped 6000 chars, request kept full;
   fire-and-forget — never blocks/fails the request).
2. ✅ `main-agent-e2e` live 3/3 incl. table test (rebuild restart observed in
   logs: "Tool rebuild detected, restarting generate … restartCount:1").
3. ✅ Full suite 970/970. One transient failure in the serial run
   (`summarization-compaction.e2e` "without stalling" → undici headers-timeout
   against the busy parallel-1 llama server) — passed in 15s on isolated re-run;
   not a code regression.
4. ✅ `tsc --noEmit` clean → 5 per-phase commits (§2) → **push PENDING**.
5. ⬜ DEPLOY (next): `blackdogbot.service` is a **user-level** systemd unit
   (`systemctl --user`, file `~/.config/systemd/user/blackdogbot.service`) —
   the system-bus `systemctl` says "could not be found". Procedure:
   `systemctl --user stop blackdogbot` → delete the stale pre-v2 Ornith key in
   `~/.blackdogbot/cache/capabilities.json` (the v2 prefix would auto-ignore
   it, but keep the file clean) → `systemctl --user start blackdogbot` →
   verify init log resolves `tool_emulated` (re-probe under v2 key).
   llama-server is also a user unit and is healthy — do not restart it.
6. ⬜ Optional: A/B sampling (coding 0.6/presence-0 vs general 1.0/presence-1.5)
   only if tool-selection issues appear.
7. ⬜ Delete `/tmp/reqdump.ts` (diagnostic scratch, must not be committed —
   item 6 superseded it; format reference only).

impl-check record: 4 independent lanes (behavior/contracts/design/runtime) on
S1; findings (all low): restart race — `triggerRebuildAsync` didn't await the
async rebuild callback (fixed: awaited + rejection caught); image re-append on
synthetic restart (fixed); wrapper duplication cron-vs-chat (fixed: one shared
`wrapCreateTableTool`); inline `pendingToolRebuild` type + redundant casts
(fixed: named shared type, no casts, accessor); per-append mkdir (fixed:
module dir cache); self-heal retry untraced (fixed: traced per HTTP request);
uncapped requestBody / no rotation (documented as intentional in llm-trace.ts).
S2 re-review: all resolved, no new findings.

## 8. Working rules for the next agent

- READ_ONLY default; enter IMPLEMENTATION only on explicit user authorization.
- No subagent model overrides (defaults only); one writer per worktree; no
  parallel lanes sharing files. Subagents only pay for independent lanes
  (e.g. the 3-lane guardrail map) — not for 4 surgical edits + test runs.
- Contract over tests: existing tests are supporting evidence; production
  callers/interfaces/config/persisted data are authoritative. Never change
  prod code + test expectations in lockstep without independent evidence.
- e2e with a local model: assert plumbing/side effects, never model behavior
  (pass counts, one-shot compliance). Capability-gate or retry where the
  model is in the loop. `tableExistsAsync` throws on missing DB — gate on
  `databaseExistsAsync` first.
- Probes must send exactly what production sends (see §4.1).
- Review route: `impl-check` (all lanes on `opencode-go/mimo-v2.5`) for
  non-trivial diffs; `implementation-review` for small ones.
- Full-suite green + `tsc` clean before any commit; diff must contain no
  unrelated churn, debris, or unused imports.
- `pnpm` only; e2e needs localhost:2345; vitest `-t` for single tests;
  background long runs with nohup → poll logs; always clean up orphans
  (`pkill -f "node (vitest`) after a killed run — orphans hold the
  parallel-1 server slot.

## 9. Key pointers

- Agent loop guards: `src/agent/base-agent.ts` (retry/compact/caps),
  `src/agent/duplicate-loop-handler.ts`, `src/agent/retry-orchestrator.ts`,
  `src/utils/prepare-step.ts` (dup-loop + idempotent-poll carve-out;
  `think-limit.ts` was deleted 2026-09-13).
- LLM trace: `src/services/ai-provider/llm-trace.ts` (env `BLACKDOG_LOG_LLM`),
  wired in `ai-provider-core.ts` `_createTokenGatedFetch` + `_appendLlmTraceAsync`.
- Rebuild flow: `wrapCreateTableTool` in `src/agent/tool-assembly.ts`,
  `ICreateTableRebuildInfo` in `src/shared/types/tool-rebuild.types.ts`,
  restart loop + `_readPendingToolRebuild` in `src/agent/main-agent.ts`,
  awaited callback in `src/services/tool-hot-reload.service.ts`.
- Provider: `src/services/ai-provider/ai-provider-core.ts` (probes ~:296,
  fetch wrapper ~:1896/:2060, token gate :1700, vision ~:2275),
  `src/services/ai-provider.service.ts` (init order :117–:263, fallback :561).
- Compaction: `src/utils/summarization-compaction.ts` (driver :202, DAG :230,
  ladder L5–L7 :344, images :404/:1351).
- Tools/prompt: `src/agent/tool-assembly.ts`, `src/agent/main-agent.ts`,
  `src/agent/cron-agent.ts:297-361`, `src/defaults/prompts/main-agent.md:39-63`,
  `src/helpers/tool-registry.ts`, `src/services/tool-hot-reload.service.ts`.
