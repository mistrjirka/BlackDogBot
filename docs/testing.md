# BetterClaw Testing Guide

## Test Structure

```
tests/
├── unit/                      # Pure unit tests (no external services)
│   ├── ascii-graph.test.ts
│   ├── channel-registry.test.ts
│   ├── graph.test.ts
│   ├── json-schema-to-zod.test.ts
│   ├── messaging.test.ts
│   ├── output-schema-blueprint.test.ts
│   ├── paths.test.ts
│   ├── schema-compat.test.ts
│   ├── telegram-message.test.ts
│   ├── tool-registry.test.ts
│   └── ...
│
├── integration/
│   ├── core/                  # Core integration tests
│   │   ├── ai-provider-e2e.test.ts
│   │   ├── base-agent.test.ts
│   │   ├── config-service.test.ts
│   │   ├── embedding-service.test.ts
│   │   ├── factory-reset.test.ts
│   │   ├── file-tools.test.ts
│   │   ├── knowledge.test.ts
│   │   ├── main-agent-e2e.test.ts
│   │   ├── prompt-service.test.ts
│   │   ├── searxng-crawl4ai-tools.test.ts
│   │   ├── skill-loader.test.ts
│   │   ├── skill-parser.test.ts
│   │   ├── skill-state.test.ts
│   │   ├── telegram-auth.test.ts
│   │   └── telegram-handler.test.ts
│   │
│   └── jobs/                  # Job-related integration tests
│       ├── add-agent-node.test.ts
│       ├── add-cron-tool.test.ts
│       ├── add-python-code-node.test.ts
│       ├── ai-job-creation-e2e.test.ts
│       ├── clear-job-graph.test.ts
│       ├── connect-nodes-validation.test.ts
│       ├── cron-agent-e2e.test.ts
│       ├── cron-message-routing.test.ts
│       ├── cron-scheduler.test.ts
│       ├── disconnect-nodes.test.ts
│       ├── graph-audit-e2e.test.ts
│       ├── graph-renderer.test.ts
│       ├── graph-tools.test.ts
│       ├── job-completion-event.test.ts
│   │   ├── job-creation-mode.test.ts
│   │   ├── job-execution-e2e.test.ts
│   │   ├── litesql-*.test.ts
│       ├── remove-node-cleanup.test.ts
│       ├── rss-*.test.ts
│       ├── scheduler.test.ts
│       └── tool-prerequisite.test.ts
```

## Running Tests

### All Tests

```bash
pnpm test
```

### By Category

```bash
# Unit tests only (fast, no external services)
pnpm test:unit

# Core integration tests (config, skills, messaging)
pnpm test:core

# Job-related integration tests (slower, more complex)
pnpm test:jobs

# Fast tests (unit + core, skips job tests)
pnpm test:fast
```

### Specific Test File

```bash
pnpm vitest run tests/unit/tool-registry.test.ts
pnpm vitest run tests/integration/core/config-service.test.ts
```

### Watch Mode

```bash
pnpm test:watch
```

## Test Categories

### Unit Tests (`tests/unit/`)

- **No external dependencies**
- **No file system access** (or only temp directories)
- **Fast execution** (should complete in <1 second each)
- **Test pure logic**: validation, parsing, formatting, calculations

Examples:
- `graph.test.ts` - DAG validation, cycle detection
- `schema-compat.test.ts` - JSON Schema compatibility checks
- `tool-registry.test.ts` - Permission-based tool filtering
- `channel-registry.test.ts` - Channel permission management

### Core Integration Tests (`tests/integration/core/`)

- **Real services** (config loading, embedding models)
- **May use file system** (temp directories)
- **Moderate execution time** (1-30 seconds each)
- **Test service interactions**: config, prompts, skills, messaging

Examples:
- `config-service.test.ts` - Config loading and validation
- `embedding-service.test.ts` - Real embedding model loading
- `telegram-handler.test.ts` - Message routing, error handling
- `skill-loader.test.ts` - Skill discovery and loading

### Job Integration Tests (`tests/integration/jobs/`)

- **Real LLM calls** (most tests)
- **Complex scenarios** (multi-node graphs, cron tasks)
- **Longer execution time** (10-60 seconds each)
- **Test full workflows**: job creation, execution, scheduling

Examples:
- `job-execution-e2e.test.ts` - Full job graph execution
- `ai-job-creation-e2e.test.ts` - Natural language job creation
- `cron-agent-e2e.test.ts` - Cron task execution with real LLM

## LLM Mocking Policy

### DO NOT Mock

- `generateText` from Vercel AI SDK
- `streamText` from Vercel AI SDK
- AI provider responses
- Tool execution results in E2E tests

### Acceptable Mocking

- Logger methods (for cleaner test output)
- File system paths (using temp directories)
- Singletons (resetting between tests)
- External services (SearXNG, Crawl4AI) when not testing them

## Memory Management

The test suite loads embedding models (~600MB). To prevent OOM:

1. **`fileParallelism: false`** is set in `vitest.config.ts`
2. Tests run sequentially to avoid loading multiple models
3. Use memory limits if needed:

```bash
systemd-run --user --scope -p MemoryHigh=5G -p MemoryMax=6G pnpm test
```

## Test Output

> **IMPORTANT**: Never pipe test output through `head`, `tail`, or `grep` when checking for failures. Test results are printed at the end and will be truncated.

**Bad:**
```bash
pnpm test | tail -50  # May hide failures!
```

**Good:**
```bash
pnpm test 2>&1 | tee /tmp/test-output.txt
# Then check the file
```

## Writing New Tests

### Unit Test Template

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { MyService } from "../../../src/services/my.service.js";

describe("MyService", () => {
  let service: MyService;

  beforeEach(() => {
    service = MyService.getInstance();
  });

  it("should do something", () => {
    const result = service.doSomething("input");
    expect(result).toBe("expected");
  });
});
```

### Integration Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function resetSingletons(): void {
  (MyService as unknown as { _instance: null })._instance = null;
}

describe("MyService Integration", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "my-test-"));
    resetSingletons();
    // Initialize services
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should work with real files", async () => {
    // Test with real file system
  });
});
```

## Current Test Count

| Category | Files | Tests |
|----------|-------|-------|
| Unit | 12 | ~155 |
| Core Integration | 19 | ~85 |
| Job Integration | 32 | ~50 |
| **Total** | **63** | **~290** |

Run `pnpm test` to see current counts.
