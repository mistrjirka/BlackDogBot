---
date: 2026-02-22
topic: "Structured output enforcement + test always-pass audit"
status: validated
---

# Structured Output Enforcement + Test Always-Pass Audit

## Problem Statement

Two related issues:

1. **Two remaining `generateText` + `JSON.parse` violations** in `job-executor.service.ts`:
   - Crawl4ai extraction (line ~618-637): Uses `generateTextWithRetryAsync` + `JSON.parse` with silent text fallback
   - Agent fallback (line ~928-935): Uses `JSON.parse(agentResult.text)` with silent degradation to `{ response: text }`

2. **Tests designed to always pass**: Multiple e2e tests only check that the LLM returned *something* rather than the *right thing*. This hid a production bug with the schema generation tool.

## Constraints

- **NEVER downgrade structured output to plain text** — hard project constraint
- Tests use real LLM calls (no mocking)
- `generateObjectWithRetryAsync` is the wrapper for structured LLM output (handles retries, rate limiting, in-flight status)
- `createOutputZodSchema()` and `jsonSchemaToZod()` convert JSON Schema to Zod for use with generateObject
- Agent nodes return final structured output as text that matches `outputSchema`

## Part A: Fix Remaining generateText Violations

### A1. Crawl4ai extraction (job-executor.service.ts ~line 618-637)

**Current code:**
```
if (config.extractionPrompt && markdown) {
  const model = aiProviderService.getDefaultModel();
  const extractionResult = await generateTextWithRetryAsync({ model, prompt: `${config.extractionPrompt}\n\nContent:\n${markdown}` });
  let extractedData;
  try { extractedData = JSON.parse(extractionResult.text.trim()); } catch { extractedData = extractionResult.text; }
  output.extracted = extractedData;
}
```

**Fix approach:**
- Look at `node.outputSchema?.properties?.extracted` to determine the expected type
- If `extracted` sub-schema has `type: "object"` with `properties` defined: use `generateObjectWithRetryAsync` with `createOutputZodSchema(extractedSubSchema)` — this is structured data extraction
- If `extracted` sub-schema has `type: "string"` OR the `extracted` property doesn't exist in outputSchema: keep `generateTextWithRetryAsync` — the output genuinely IS text
- Remove the silent `try/catch` JSON.parse fallback — if we expect structured output, a parse failure should be an error

**Key detail:** The `extracted` sub-schema comes from `node.outputSchema.properties.extracted`. This is user-defined when creating the crawl4ai node. The `createOutputZodSchema()` function handles any valid JSON Schema object.

### A2. Agent fallback (job-executor.service.ts ~line 928-935)

**Current code:**
```
if (Object.keys(output).length === 0 && agentResult.text) {
  try { output = JSON.parse(agentResult.text.trim()); }
  catch { output = { response: agentResult.text }; }
}
```

**Fix approach:**
- Remove this entire fallback block
- If the agent didn't produce valid structured output in final text, that's an error — throw it
- Final text JSON matching `outputSchema` IS the structured output mechanism for agents
- Silent degradation to unvalidated JSON parsing defeats the purpose of schema enforcement
- Replace with: if output is empty and agent completed, throw an error indicating the agent failed to return valid structured output

## Part B: Fix Always-Pass Tests

### Anti-pattern identified

The root cause: tests assert on **structure** (is it defined? is it a boolean?) instead of **correctness** (is it the RIGHT value?). Some tests have the comment "We don't assert on approved being true since LLM behavior varies" — this is the wrong philosophy. LLM output should be validated for correctness, not just existence.

### B1. graph-audit-e2e.test.ts — 2 tests

**Test: "should audit a valid graph with LLM and approve it"**
- Current: `expect(typeof result.approved).toBe('boolean')` — any boolean passes
- Fix: `expect(result.approved).toBe(true)` — a valid graph MUST be approved
- Also assert: `expect(result.issues).toHaveLength(0)` or issues are all warnings, not errors

**Test: "should audit a problematic graph and return issues"**
- Current: conditional `if (!result.approved) { expect(issues.length > 0) }` — skipped if approved
- Fix: `expect(result.approved).toBe(false)` unconditionally
- Fix: `expect(result.issues.length).toBeGreaterThan(0)` unconditionally
- Remove the `if` wrapper — the assertion must always run

### B2. create-output-schema.e2e.test.ts — 4 tests

**Test: "should create a valid schema for simple object output"**
- Current: checks `schema.type === 'object'` and `schema.properties` defined
- Fix: assert `schema.properties` contains keys `title` and `count` (the requested fields)
- Fix: assert property types match (title → string, count → number/integer)

**Test: "should create a valid schema for array output"**
- Current: checks an array property exists with items
- Fix: assert items.properties contains `title`, `link`, `is_verified`

**Test: "should create schema with required fields when specified"**
- Current: checks required contains "id"
- Fix: also check that `name` is NOT in the required array (it was specified as optional)

**Test: "should handle complex nested schema request"**
- Current: checks properties exist and items has sub-properties
- Fix: assert specific nested field names from the prompt exist

### B3. job-execution-e2e.test.ts — crawl4ai extraction test

**Test: crawl4ai with extractionPrompt**
- Current: `expect(output.extracted).toBeDefined()`
- Fix: `expect(typeof output.extracted).toBe('object')`
- Fix: `expect(output.extracted).toHaveProperty('title')`
- Fix: `expect(typeof output.extracted.title).toBe('string')`

### B4. llm-retry-e2e.test.ts — 1 test

**Test: "should call a real LLM and return a non-empty text response"**
- Current: `expect(result.text.length).toBeGreaterThan(0)`
- Fix: `expect(result.text.toLowerCase()).toContain('ok')`

### B5. base-agent-e2e.test.ts — 1 test

**Test: "should process a message with a real LLM and return a result"**
- Current: checks result defined, text is string
- Fix: `expect(result.text).toContain('4')` — answer to "What is 2+2?"

### B6. main-agent-e2e.test.ts — 1 test

**Test: "should process a simple message..."**
- Current: checks result defined and text is string
- Fix: `expect(result.text.length).toBeGreaterThan(0)` at minimum
- Better: add a factual question with a verifiable answer instead of "hello world"

### B7. cron-agent-e2e.test.ts — 1 test

**Test: "should execute a scheduled task..."**
- Current: checks result defined
- Fix: `expect(result.text).toContain('42')` — the task says "mention the number 42"

## Testing Strategy

- Run each modified test file individually to verify the assertions catch real issues
- Run full integration test suite to check for regressions
- Run typecheck

## Open Questions

None — all decisions are made.
