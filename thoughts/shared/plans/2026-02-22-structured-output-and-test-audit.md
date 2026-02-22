# Structured Output Enforcement + Test Audit Implementation Plan

**Goal:** Eliminate remaining structured-output violations in `JobExecutorService` and harden e2e tests so they validate correctness instead of always passing.

**Architecture:** Replace ad-hoc `generateText` + `JSON.parse` paths with schema-aware `generateObjectWithRetryAsync` for crawl4ai extraction and enforce the `done` tool as the only agent output channel. Update integration tests to assert concrete values/structures. Design requires structured output; I’m implementing schema-type branching with explicit object vs text behavior to preserve legitimate text outputs.

**Design:** `thoughts/shared/designs/2026-02-22-structured-output-and-test-audit-design.md`

---

## Dependency Graph

```
Batch 1 (parallel): 1.1 [core - no deps]
Batch 2 (parallel): 2.1, 2.2, 2.3, 2.4, 2.5, 2.6 [tests - no deps]
Batch 3 (parallel): 3.1 [tests - depends on 1.1]
```

---

## Batch 1: Core (parallel - 1 implementer)

### Task 1.1: Enforce structured output for crawl4ai + agent done tool
**File:** `src/services/job-executor.service.ts`
**Test:** `tests/integration/job-execution-e2e.test.ts` (crawl4ai extraction test)
**Depends:** none

**Change summary:**
- Crawl4ai extraction: inspect `node.outputSchema?.properties?.extracted` to choose structured vs text extraction.
- Use `generateObjectWithRetryAsync` + `createOutputZodSchema(extractedSchema)` when `extracted` is an object schema with properties.
- Keep `generateTextWithRetryAsync` for `type: "string"` or missing `extracted`.
- Remove JSON.parse fallback.
- Agent fallback: remove JSON.parse block and throw error if no `done` output.

```typescript
// Replace the crawl4ai extraction block (around lines ~618-637)
// with the following complete block:

    // If extraction prompt is provided, run AI extraction on the markdown content
    if (config.extractionPrompt && markdown) {
      const aiProviderService: AiProviderService = AiProviderService.getInstance();
      const model: LanguageModel = aiProviderService.getDefaultModel();

      const outputSchema: Record<string, unknown> | undefined = node.outputSchema as Record<string, unknown> | undefined;
      const outputProperties: Record<string, unknown> | undefined = outputSchema?.properties as Record<string, unknown> | undefined;
      const extractedSchema: Record<string, unknown> | undefined = outputProperties?.extracted as Record<string, unknown> | undefined;
      const extractedType: unknown = extractedSchema?.type;
      const extractedProperties: unknown = extractedSchema?.properties;
      const shouldUseStructuredExtraction: boolean =
        !!extractedSchema &&
        extractedType === "object" &&
        typeof extractedProperties === "object" &&
        extractedProperties !== null;

      if (shouldUseStructuredExtraction) {
        const extractionResult = await generateObjectWithRetryAsync({
          model,
          prompt: `${config.extractionPrompt}\n\nContent:\n${markdown}`,
          schema: createOutputZodSchema(extractedSchema),
        });

        output.extracted = extractionResult.object as Record<string, unknown>;
      } else {
        const extractionResult = await generateTextWithRetryAsync({
          model,
          prompt: `${config.extractionPrompt}\n\nContent:\n${markdown}`,
        });

        output.extracted = extractionResult.text;
      }
    }
```

```typescript
// Replace the agent fallback block (around lines ~928-935)
// with the following complete block:

    if (Object.keys(output).length === 0) {
      throw new Error(
        `Agent node "${node.nodeId}" completed without calling the done tool. ` +
        `Ensure the agent returns output via done with a result matching the output schema.`,
      );
    }
```

**Verify:**
- `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/job-execution-e2e.test.ts`
- `pnpm typecheck`

**Commit:** `fix(job-executor): enforce structured crawl4ai extraction and done-only agent output`

---

## Batch 2: Tests (parallel - 6 implementers)

### Task 2.1: Tighten graph audit approval assertions
**File:** `tests/integration/graph-audit-e2e.test.ts`
**Test:** (this file)
**Depends:** none

```typescript
// In "should audit a valid graph with LLM and approve it",
// replace the assertion block with:

    expect(result).toBeDefined();
    expect(result.approved).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(Array.isArray(result.suggestions)).toBe(true);
```

```typescript
// In "should audit a problematic graph and return issues",
// replace the assertion block with:

    expect(result).toBeDefined();
    expect(result.approved).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(Array.isArray(result.suggestions)).toBe(true);
```

**Verify:** `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/graph-audit-e2e.test.ts`
**Commit:** `test(graph-audit): assert approvals and issues explicitly`

---

### Task 2.2: Assert schema correctness in create-output-schema E2E
**File:** `tests/integration/create-output-schema.e2e.test.ts`
**Test:** (this file)
**Depends:** none

```typescript
// In "should create a valid schema for simple object output",
// replace the assertions with:

    const schema = result.object;
    expect(schema.type).toBe("object");

    const properties = schema.properties as Record<string, { type?: string }>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["title", "count"]));
    expect(properties.title?.type).toBe("string");
    expect(["number", "integer"]).toContain(properties.count?.type);
```

```typescript
// In "should create a valid schema for array output",
// replace the assertions with:

    const schema = result.object;
    expect(schema.type).toBe("object");

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const arrayKey: string | undefined = Object.keys(properties).find(
      (key) => properties[key]?.type === "array",
    );
    expect(arrayKey).toBeDefined();

    const arrayProperty = properties[arrayKey!] as Record<string, unknown>;
    const itemSchema = arrayProperty.items as Record<string, unknown>;
    const itemProperties = itemSchema?.properties as Record<string, unknown>;

    expect(itemProperties).toBeDefined();
    expect(Object.keys(itemProperties)).toEqual(
      expect.arrayContaining(["title", "link", "is_verified"]),
    );
```

```typescript
// In "should create schema with required fields when specified",
// add the optional-field check:

    const schema = result.object;
    expect(schema.type).toBe("object");

    const required = schema.required as string[] | undefined;
    expect(required).toBeDefined();
    expect(required).toContain("id");
    expect(required).not.toContain("name");
```

```typescript
// In "should handle complex nested schema request",
// replace the nested assertions with:

    const schema = result.object;
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.items).toBeDefined();

    const itemsSchema = properties.items as Record<string, unknown>;
    expect(itemsSchema.type).toBe("array");
    expect(itemsSchema.items).toBeDefined();

    const itemSchema = itemsSchema.items as Record<string, unknown>;
    const itemProperties = itemSchema.properties as Record<string, unknown>;

    expect(Object.keys(itemProperties)).toEqual(
      expect.arrayContaining(["id", "title", "metadata", "tags"]),
    );

    const metadataSchema = itemProperties.metadata as Record<string, unknown>;
    const metadataProperties = metadataSchema.properties as Record<string, unknown>;
    expect(Object.keys(metadataProperties)).toEqual(
      expect.arrayContaining(["created_at", "updated_at"]),
    );

    const tagsSchema = itemProperties.tags as Record<string, unknown>;
    expect(tagsSchema.type).toBe("array");
    const tagItemSchema = tagsSchema.items as Record<string, unknown>;
    expect(tagItemSchema.type).toBe("string");
```

**Verify:** `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/create-output-schema.e2e.test.ts`
**Commit:** `test(create-output-schema): assert required fields and nested properties`

---

### Task 2.3: Tighten llm-retry E2E expectation
**File:** `tests/integration/llm-retry-e2e.test.ts`
**Test:** (this file)
**Depends:** none

```typescript
// In "should call a real LLM and return a non-empty text response",
// replace the final assertion with:

    expect(result.text.toLowerCase()).toContain("ok");
```

**Verify:** `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/llm-retry-e2e.test.ts`
**Commit:** `test(llm-retry): assert explicit ok response`

---

### Task 2.4: Assert math answer in base-agent E2E
**File:** `tests/integration/base-agent-e2e.test.ts`
**Test:** (this file)
**Depends:** none

```typescript
// In "should process a message with a real LLM and return a result",
// add the following assertion:

    expect(result.text).toContain("4");
```

**Verify:** `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/base-agent-e2e.test.ts`
**Commit:** `test(base-agent): assert correct math response`

---

### Task 2.5: Ensure main-agent returns non-empty output
**File:** `tests/integration/main-agent-e2e.test.ts`
**Test:** (this file)
**Depends:** none

```typescript
// In "should process a simple message and return a result",
// add this assertion:

    expect(result.text.length).toBeGreaterThan(0);
```

**Verify:** `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/main-agent-e2e.test.ts`
**Commit:** `test(main-agent): assert non-empty response`

---

### Task 2.6: Assert scheduled task mentions 42
**File:** `tests/integration/cron-agent-e2e.test.ts`
**Test:** (this file)
**Depends:** none

```typescript
// In "should execute a scheduled task using the think tool and return a result",
// add this assertion:

    expect(result.text).toContain("42");
```

**Verify:** `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/cron-agent-e2e.test.ts`
**Commit:** `test(cron-agent): assert task summary mentions 42`

---

## Batch 3: Tests (parallel - 1 implementer)

### Task 3.1: Enforce structured crawl4ai extraction assertions
**File:** `tests/integration/job-execution-e2e.test.ts`
**Test:** (this file)
**Depends:** 1.1

```typescript
// In "should execute a crawl4ai node with extraction prompt",
// replace the extracted assertions with:

    expect(typeof output.extracted).toBe("object");
    expect(output.extracted).toHaveProperty("title");
    expect(typeof (output.extracted as Record<string, unknown>).title).toBe("string");
```

**Verify:** `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose tests/integration/job-execution-e2e.test.ts`
**Commit:** `test(job-execution): assert crawl4ai extraction structure`

---

## Global Verification

- `pnpm typecheck`
- Run each modified test file individually (as above)
- Full integration suite: `pnpm vitest run --config vitest.integration.config.ts --reporter=verbose`
