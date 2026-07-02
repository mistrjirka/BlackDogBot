/**
 * 6 failing tests — one per behavioral issue from the impl-check review.
 *
 * Tests 1 & 5 exercise real code (schemas). Tests 2–4 & 6 verify source code
 * contains the correct pattern (the functions are private / deeply nested and
 * cannot be unit-tested without complex mocking).
 *
 * Before fix: all 6 fail.
 * After fix:  all 6 pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scheduleOnceSchema } from "../../src/shared/schemas/cron.schemas.js";
import { configSchema } from "../../src/shared/schemas/config.schemas.js";

const SRC = resolve(import.meta.dirname, "../../src");

function readSrc(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), "utf-8");
}

// ============================================================================
// Issue 1: Once-task migration drops `runAt`
// Source: src/services/scheduler.service.ts:599-613
//
// The migration object must include `runAt` for once-type schedules,
// otherwise scheduleOnceSchema validation fails and the task is silently lost.
// ============================================================================
describe("Issue 1: Once-task migration drops runAt", () => {
  it("scheduler.service migration for once-type must include runAt", () => {
    const source = readSrc("services/scheduler.service.ts");
    // After fix: the migration branch for once-type must set runAt
    expect(source).toMatch(/migratedSchedule\.runAt\s*=/);
  });
});

// ============================================================================
// Issue 2: `stepsCount` fallback uses `maxSteps` instead of `1`
// Source: src/agent/retry-orchestrator.ts:144
//
// `steps?.length ?? maxSteps` returns maxSteps (300) when steps is undefined.
// The correct fallback for "how many steps did we just run" is 1.
// ============================================================================
describe("Issue 2: stepsCount fallback uses maxSteps instead of 1", () => {
  it("retry-orchestrator must use || 1 not ?? maxSteps for stepsCount", () => {
    const source = readSrc("agent/retry-orchestrator.ts");
    // After fix: must use || 1 (truthy fallback), not ?? maxSteps (nullish coalescing)
    expect(source).toMatch(/steps\?\.length\s*\|\|\s*1/);
    expect(source).not.toMatch(/steps\?\.length\s*\?\?\s*maxSteps/);
  });
});

// ============================================================================
// Issue 3: `_findFirstUserTask` broken type assertion
// Source: src/agent/duplicate-loop-handler.ts:254
//
// `typeof (part as { text: unknown }) === "string"` checks typeof on the
// part OBJECT (always "object"), not on part.text. The condition is never
// true for array-content user messages, so the adviser always gets "".
// ============================================================================
describe("Issue 3: _findFirstUserTask typeof check tests object, not .text", () => {
  it("duplicate-loop-handler typeof must check .text property, not the object", () => {
    const source = readSrc("agent/duplicate-loop-handler.ts");
    // After fix: typeof must access .text on the cast object
    expect(source).toMatch(/typeof\s+\(part\s+as\s+\{\s*text:\s*unknown\s*\}\)\.text\s*===\s*"string"/);
  });
});

// ============================================================================
// Issue 4: Wrong field `value` instead of `text` in compaction output
// Source: src/utils/summarization-compaction.ts:1158-1160
//
// _replaceToolMessageContentWithSummary creates { type: "text", value: text }
// but _extractTextContent at line 1366 checks "text" in part, so it never
// finds the compacted text.
// ============================================================================
describe("Issue 4: Compaction output uses 'value' instead of 'text'", () => {
  it("summarization-compaction replacement output must use 'text' field, not 'value'", () => {
    const source = readSrc("utils/summarization-compaction.ts");
    // After fix: the replacementOutput must have `text:` not `value:`
    expect(source).toMatch(/type:\s*"text",\s*\n\s*text:\s*compactedText/);
  });
});

// ============================================================================
// Issue 5: Discord config silently stripped by Zod schema
// Source: src/shared/schemas/config.schemas.ts:273-289
//
// configSchema has no `discord` field, so Zod's default strip mode removes
// the discord section from parsed config.
// ============================================================================
describe("Issue 5: Discord config stripped by Zod schema", () => {
  it("configSchema should preserve the discord field after parsing", () => {
    const configWithDiscord = {
      ai: { provider: "openrouter" },
      discord: {
        botToken: "test-token",
        channels: [],
      },
    };

    const result = configSchema.safeParse(configWithDiscord);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty("discord");
    }
  });
});

// ============================================================================
// Issue 6: Context-exceeded retry doesn't trigger compaction
// Source: src/agent/retry-orchestrator.ts:222-234
//
// When a context-exceeded error occurs, the handler just logs and does
// `attempt--; continue;` without invoking any compaction callback. The next
// retry sends the same oversized context, guaranteed to fail again.
// ============================================================================
describe("Issue 6: Context-exceeded retry doesn't trigger compaction", () => {
  it("retry-orchestrator context-exceeded path must call onContextExceededCompaction", () => {
    const source = readSrc("agent/retry-orchestrator.ts");
    // After fix: the context-exceeded branch must invoke the compaction callback
    expect(source).toMatch(/onContextExceededCompaction\(\)/);
  });
});
