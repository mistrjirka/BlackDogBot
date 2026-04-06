# Parallel Tool Calls — Startup Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a startup probe that detects whether the OpenAI-compatible server (llama.cpp) accepts the `parallel_tool_calls` parameter, cache the result in-memory, and use it to dynamically enable parallel tool calls.

**Architecture:** Extend `AiCapabilityService` with a `probeParallelToolCallSupportAsync()` method that sends a minimal request with `parallel_tool_calls: true` and checks for a non-error response. Wire the probe into `src/index.ts` startup. Use the cached result in `langchain-model.service.ts` to conditionally inject `parallel_tool_calls` into `modelKwargs`.

**Tech Stack:** TypeScript, Vitest, LangChain, OpenAI-compatible API (llama.cpp)

---

### Task 1: Add `supportsParallelToolCalls` to `AiCapabilityService`

**Files:**
- Modify: `src/services/ai-capability.service.ts`
- Test: `tests/unit/services/ai-capability.service.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/services/ai-capability.service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { createTestEnvironment, resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";

const env = createTestEnvironment("ai-capability-unit");

describe("AiCapabilityService", () => {
  let service: AiCapabilityService;

  beforeEach(async () => {
    await env.setupAsync({ logLevel: "error" });
    resetSingletons();
    const logger = LoggerService.getInstance();
    silenceLogger(logger);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();
    await env.teardownAsync();
  });

  describe("getSupportsParallelToolCalls", () => {
    beforeEach(() => {
      service = AiCapabilityService.getInstance();
    });

    it("returns false by default (before probe)", () => {
      service.initialize({
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "http://localhost:2345/v1",
          apiKey: "test-key",
          model: "qwen3.5:latest",
        },
      });
      expect(service.getSupportsParallelToolCalls()).toBe(false);
    });

    it("returns true after setSupportsParallelToolCalls(true)", () => {
      service.initialize({
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "http://localhost:2345/v1",
          apiKey: "test-key",
          model: "qwen3.5:latest",
        },
      });
      service.setSupportsParallelToolCalls(true);
      expect(service.getSupportsParallelToolCalls()).toBe(true);
    });

    it("returns false after setSupportsParallelToolCalls(false)", () => {
      service.initialize({
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "http://localhost:2345/v1",
          apiKey: "test-key",
          model: "qwen3.5:latest",
        },
      });
      service.setSupportsParallelToolCalls(false);
      expect(service.getSupportsParallelToolCalls()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jirka/programy/better-claw && npx vitest run tests/unit/services/ai-capability.service.test.ts`
Expected: FAIL — `getSupportsParallelToolCalls` and `setSupportsParallelToolCalls` don't exist.

- [ ] **Step 3: Write minimal implementation**

Modify `src/services/ai-capability.service.ts`:

Add private field after `_config`:
```typescript
private _supportsParallelToolCalls: boolean = false;
```

Add getter and setter after `getSupportsVision()` (before `getCapabilityInfo()`):
```typescript
/**
 * Check if the current model/server supports parallel tool calls.
 * Returns false until explicitly set via probe or config override.
 */
public getSupportsParallelToolCalls(): boolean {
  return this._supportsParallelToolCalls;
}

/**
 * Set the parallel tool calls support flag.
 * Called by the startup probe or config override.
 */
public setSupportsParallelToolCalls(supported: boolean): void {
  this._supportsParallelToolCalls = supported;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jirka/programy/better-claw && npx vitest run tests/unit/services/ai-capability.service.test.ts`
Expected: PASS — all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/jirka/programy/better-claw && git add src/services/ai-capability.service.ts tests/unit/services/ai-capability.service.test.ts && git commit -m "feat: add parallel tool calls capability flag to AiCapabilityService"
```

---

### Task 2: Implement the probe function

**Files:**
- Create: `src/services/parallel-tool-call-probe.service.ts` (new file)
- Test: `tests/unit/services/parallel-tool-call-probe.service.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/services/parallel-tool-call-probe.service.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { probeParallelToolCallSupportAsync } from "../../../src/services/parallel-tool-call-probe.service.js";

describe("probeParallelToolCallSupportAsync", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when server responds 200 OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 5000,
    });

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:2345/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("returns false when server responds 400", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "unknown parameter" } }),
    });

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 5000,
    });

    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 5000,
    });

    expect(result).toBe(false);
  });

  it("returns false on timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10000)),
    );

    const result = await probeParallelToolCallSupportAsync({
      baseUrl: "http://localhost:2345/v1",
      apiKey: "test-key",
      model: "qwen3.5:latest",
      timeoutMs: 100,
    });

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jirka/programy/better-claw && npx vitest run tests/unit/services/parallel-tool-call-probe.service.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/parallel-tool-call-probe.service.ts`:

```typescript
export interface IProbeParallelToolCallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/**
 * Probe whether the OpenAI-compatible server accepts the parallel_tool_calls parameter.
 * Sends a minimal request with parallel_tool_calls: true and checks for a non-error response.
 * Returns true if the server responds OK, false otherwise.
 */
export async function probeParallelToolCallSupportAsync(
  options: IProbeParallelToolCallOptions,
): Promise<boolean> {
  const { baseUrl, apiKey, model, timeoutMs = 10000 } = options;

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: "Say ok" }],
    max_tokens: 4,
    parallel_tool_calls: true,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jirka/programy/better-claw && npx vitest run tests/unit/services/parallel-tool-call-probe.service.test.ts`
Expected: PASS — all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/jirka/programy/better-claw && git add src/services/parallel-tool-call-probe.service.ts tests/unit/services/parallel-tool-call-probe.service.test.ts && git commit -m "feat: add parallel tool call probe service"
```

---

### Task 3: Wire probe into startup and use result in model creation

**Files:**
- Modify: `src/index.ts` (add probe call after `AiCapabilityService.initialize()`)
- Modify: `src/services/langchain-model.service.ts` (use capability flag in `modelKwargs`)

- [ ] **Step 1: Wire probe into `src/index.ts`**

Add import at the top (after line 13):
```typescript
import { probeParallelToolCallSupportAsync } from "./services/parallel-tool-call-probe.service.js";
```

After line 41 (`AiCapabilityService.getInstance().initialize(config.ai);`), add:

```typescript
  // Probe parallel tool call support for local providers
  const aiCapabilityService = AiCapabilityService.getInstance();
  const activeProvider = aiCapabilityService.getActiveProvider();
  if (activeProvider === "openai-compatible" || activeProvider === "lm-studio") {
    const providerConfig = activeProvider === "openai-compatible"
      ? config.ai.openaiCompatible
      : config.ai.lmStudio;

    if (providerConfig) {
      const supported = await probeParallelToolCallSupportAsync({
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey ?? "lm-studio",
        model: providerConfig.model,
        timeoutMs: 10000,
      });
      aiCapabilityService.setSupportsParallelToolCalls(supported);
      logger.info("Parallel tool call probe completed", { supported });
    }
  }
```

- [ ] **Step 2: Use capability flag in `langchain-model.service.ts`**

Add import at the top (after line 8):
```typescript
import { AiCapabilityService } from "./ai-capability.service.js";
```

After line 120 (end of profile block closing brace, before the `disableThinking` block at line 122), add:

```typescript
  // If profile didn't set parallel_tool_calls, check capability service
  if (modelKwargs.parallel_tool_calls === undefined) {
    const supported = AiCapabilityService.getInstance().getSupportsParallelToolCalls();
    if (supported) {
      modelKwargs.parallel_tool_calls = true;
    }
  }
```

- [ ] **Step 3: Run all unit tests to verify nothing broke**

Run: `cd /home/jirka/programy/better-claw && npx vitest run tests/unit`
Expected: All tests pass.

- [ ] **Step 4: Run typecheck**

Run: `cd /home/jirka/programy/better-claw && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
cd /home/jirka/programy/better-claw && git add src/index.ts src/services/langchain-model.service.ts && git commit -m "feat: wire parallel tool call probe into startup and model creation"
```

---

### Task 4: Add test for capability-aware model creation

**Files:**
- Modify: `tests/unit/services/langchain-model.service.test.ts`

- [ ] **Step 1: Add tests for capability service integration**

Add to `tests/unit/services/langchain-model.service.test.ts` (append after existing tests):

```typescript
import { beforeEach, afterEach } from "vitest";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";

describe("createChatModel parallel tool calls from capability service", () => {
  beforeEach(() => {
    (AiCapabilityService as unknown as { _instance: unknown })._instance = null;
  });

  afterEach(() => {
    (AiCapabilityService as unknown as { _instance: unknown })._instance = null;
  });

  it("injects parallel_tool_calls when capability service says supported", () => {
    const capabilityService = AiCapabilityService.getInstance();
    capabilityService.initialize({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    });
    capabilityService.setSupportsParallelToolCalls(true);

    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    };

    const model = createChatModel(config);
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.parallel_tool_calls).toBe(true);
  });

  it("does not inject parallel_tool_calls when capability service says unsupported", () => {
    const capabilityService = AiCapabilityService.getInstance();
    capabilityService.initialize({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    });
    capabilityService.setSupportsParallelToolCalls(false);

    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    };

    const model = createChatModel(config);
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.parallel_tool_calls).toBe(undefined);
  });

  it("profile parallel_tool_calls takes precedence over capability service", () => {
    const capabilityService = AiCapabilityService.getInstance();
    capabilityService.initialize({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
      },
    });
    capabilityService.setSupportsParallelToolCalls(false);

    const config: IAiConfig = {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:2345/v1",
        apiKey: "test-key",
        model: "qwen3.5:latest",
        activeProfile: "qwen3_5",
      },
    };

    const model = createChatModel(config);
    const modelKwargs = (model as unknown as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};

    expect(modelKwargs.parallel_tool_calls).toBe(true);
  });
});
```

- [ ] **Step 2: Run the updated test file**

Run: `cd /home/jirka/programy/better-claw && npx vitest run tests/unit/services/langchain-model.service.test.ts`
Expected: All tests pass (existing + new).

- [ ] **Step 3: Run full unit test suite**

Run: `cd /home/jirka/programy/better-claw && npx vitest run tests/unit`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd /home/jirka/programy/better-claw && git add tests/unit/services/langchain-model.service.test.ts && git commit -m "test: add capability service integration tests for parallel tool calls"
```

---

### Task 5: Run full verification

- [ ] **Step 1: Run all tests**

Run: `cd /home/jirka/programy/better-claw && npx vitest run`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `cd /home/jirka/programy/better-claw && npx tsc --noEmit`
Expected: No type errors.
