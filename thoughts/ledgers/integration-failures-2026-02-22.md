# Integration failure investigation (2026-02-22)

## Scope
Targeted suites:
- `tests/integration/job-creation-mode.test.ts`
- `tests/integration/create-output-schema.e2e.test.ts`
- `tests/integration/dynamic-schema-agent-node.e2e.test.ts`
- `tests/integration/job-execution-e2e.test.ts`

## Issues found

1. **Strict JSON schema rejection from provider (OpenRouter/Azure path)**
   - Error class: `AI_APICallError` with `invalid_json_schema`.
   - Observed payload issue: generated response schema had `additionalProperties: {}` under a property map, and provider required typed schema nodes in strict mode.
   - Affected tests: all `create-output-schema.e2e` tests + both `dynamic-schema-agent-node.e2e` tests.

2. **Job creation mandatory-audit test had brittle failure mode**
   - If first mandatory audit failed due LLM/provider error, tool returned failure without actionable `validationErrors` content.
   - Affected test: `finish_job_creation should IGNORE skipAudit on first call`.

3. **Crawl4AI extraction structured output failed previously**
   - Structured extraction path used strict object generation and failed when schema shape was not provider-compatible.
   - This now passes after strict-compatible schema handling in execution path and converter behavior.

## Fixes employed

### Production code

- `src/tools/finish-job-creation.tool.ts`
  - Added explicit catch around LLM audit call.
  - On audit LLM error, returns non-empty `validationErrors` with concrete error text.
  - Keeps mandatory-first-audit behavior and does not bypass LLM validation.

- `src/tools/create-output-schema.tool.ts`
  - Reworked schema generation to a **strict, non-recursive blueprint contract** for `generateObject` (provider-safe structured output).
  - Added deterministic conversion from blueprint -> final JSON Schema in code.
  - Added prompt constraints to preserve explicitly requested field names and avoid invented wrapper top-level keys.
  - Keeps strict JSON and LLM structured output fully enabled.

- `src/utils/json-schema-to-zod.ts`
  - Changed non-required object fields from `.optional()` to `.nullable()` to align with strict structured-output compatibility guidance.

- `src/services/ai-provider.service.ts`
  - Removed the provider-level global schema normalization shim.
  - Kept wrapper responsibility minimal (rate limiting only).

### Test updates (for valid reason)

- `tests/integration/create-output-schema.e2e.test.ts`
- `tests/integration/dynamic-schema-agent-node.e2e.test.ts`
  - Updated tests to execute the actual `create_output_schema` tool path instead of duplicating a fragile local schema contract.
  - Adjusted one nested-type assertion to accept strict-compatible nullable unions (`["object", "null"]`, `["array", "null"]`).
  - Rationale: validates real production behavior and avoids test-only schema drift.

## Current status

- Final verification run passed for all originally failing suites:
  - `tests/integration/job-creation-mode.test.ts`
  - `tests/integration/create-output-schema.e2e.test.ts`
  - `tests/integration/dynamic-schema-agent-node.e2e.test.ts`
  - `tests/integration/job-execution-e2e.test.ts`
- Result: `Test Files 4 passed`, `Tests 37 passed`.

## Notes

- No LLM paths were removed.
- No strict JSON behavior was disabled.
- No schema generation was downgraded to text output.
