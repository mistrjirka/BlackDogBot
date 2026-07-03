# Search Timed And Task Update Guardrails Design

## Context

Scheduled-task updates should be done through scheduled-task tools, not direct file edits. Task discovery should rely on scheduler metadata and deterministic lookup behavior. This reduces ambiguity and unexpected behavior.

The system needs a deterministic way to find scheduled tasks by partial information (name, URL fragments, description text, tool names) without relying on file-level search.

## Goals

1. Keep scheduled-task configuration changes inside scheduled-task tools.
2. Add deterministic fuzzy search for scheduled tasks only.
3. Return transparent match reasons (which fields matched) and ranking scores.
4. Preserve existing `list_timed` behavior and compatibility.

## Non-Goals

1. No embedding-based semantic search for this feature.
2. No search across prompts, docs, files, or knowledge collections.
3. No behavior change to `list_timed` response shape.

## Decisions

1. Add a new tool: `search_timed`.
2. Keep `list_timed` unchanged; do not add fuzzy parameters to it.
3. Use deterministic fuzzy ranking via `fuse.js` with weighted fields.
4. Show where each result matched via `matchedFields`.
5. Include a short `instructions` preview in each match (truncated).
6. In prompt workflow guidance, enforce positive tool workflow (`get_timed` -> `edit_*` / `edit_instructions`) without mentioning shell/file-search alternatives.

## Approach Comparison

### A) New `search_timed` with `fuse.js` (recommended)

- Pros: mature deterministic fuzzy search, weighted keys, straightforward scoring, maintainable API.
- Cons: adds one dependency.

### B) New `search_timed` with custom scorer

- Pros: no dependency.
- Cons: higher implementation and tuning cost, higher relevance/regression risk.

### C) New `search_timed` with `fuzzysort`

- Pros: very fast and small.
- Cons: less ergonomic for field attribution + response shaping in this use case.

## API Design

### Tool Name

`search_timed`

### Input

- `query: string` (required, trimmed, min length 1)
- `enabledOnly?: boolean` (default `false`)
- `limit?: number` (default `5`, max `20`)
- `threshold?: number` (default `0.4`, range `0..1`, lower is stricter)

### Output

- `query: string`
- `totalMatches: number`
- `matches: Array<...>` where each item contains:
  - `taskId: string`
  - `name: string`
  - `description: string`
  - `enabled: boolean`
  - `schedule: Schedule`
  - `score: number` (0..1, normalized so higher is better)
  - `matchedFields: string[]`
  - `preview: { instructions: string }` (truncated)

## Matching Model

Use `fuse.js` with these weighted keys:

- `name`: `0.40`
- `description`: `0.25`
- `instructions`: `0.20`
- `taskId`: `0.10`
- `tools`: `0.05`

Configuration:

- `includeScore: true`
- `includeMatches: true`
- `ignoreLocation: true`
- `minMatchCharLength: 2`
- tool-level `threshold` from input (default `0.4`)

Field extraction for `matchedFields`:

1. Read Fuse `matches[].key` values.
2. Map to normalized field names (`name`, `description`, `instructions`, `taskId`, `tools`).
3. De-duplicate while preserving first-seen order.

Score normalization:

- Fuse scores lower=better; export `score = 1 - rawScore`.
- Clamp to `[0, 1]` and round for stable output.

## Agent Workflow Integration

When user references a scheduled task without exact `taskId`:

1. Call `search_timed` to identify candidates.
2. Select candidate (usually highest score).
3. Call `get_timed` for selected task (existing prerequisite contract).
4. Apply `edit_interval` / `edit_once` / `edit_instructions` as needed.

`list_timed` remains the broad inventory tool; `search_timed` is the targeted discovery tool.

## Prompt/Guidance Changes

Update timed workflow prompt fragment to emphasize only the intended scheduled-task tool flow for updates.

## Files To Change

1. `src/tools/search-timed.tool.ts` (new)
2. `src/tools/index.ts`
3. `src/agent/main-agent.ts`
4. `src/agent/cron-agent.ts`
5. `src/shared/schemas/tool-schemas.ts`
6. `src/shared/constants/cron-descriptions.ts`
7. `src/defaults/prompts/prompt-fragments/timed-update-workflow.md`
8. Tests under `tests/unit/tools/`

## Test Strategy (TDD)

Write tests first and verify failure before implementation.

### New Tests

1. `search_timed` returns ranked matches with scores.
2. `search_timed` includes `matchedFields` for each match.
3. `search_timed` finds URL-fragment queries via `instructions` content.
4. `enabledOnly=true` excludes disabled tasks.
5. `limit` bounds result count.
6. `list_timed` behavior remains unchanged (regression guard).

### Verification Sequence

1. Run targeted new test file (expect RED).
2. Implement minimal code to pass (GREEN).
3. Re-run targeted test file.
4. Run related tool/schema prompt tests.
5. Run `pnpm typecheck`.

## Risks And Mitigations

1. Ranking surprises on short queries
   - Mitigation: weighted keys + configurable threshold + capped limits.
2. Overexposure of long instructions
   - Mitigation: truncated preview only.
3. Prompt drift between workflow and tool contracts
   - Mitigation: keep prompt wording aligned with `get_timed` prerequisites and edit-tool contracts.

## Acceptance Criteria

1. `search_timed` exists and is registered for main and cron agents.
2. Query by partial URL/task text returns correct task near top with `matchedFields` populated.
3. Scheduled-task update workflow guidance uses scheduled-task tool flow only.
4. `list_timed` output contract is unchanged.
5. New and impacted tests pass.
