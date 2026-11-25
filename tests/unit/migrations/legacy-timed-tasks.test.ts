import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { migrateLegacyTimedTask } from "../../../src/migrations/legacy-timed-tasks.js";

const options = { defaultTimezone: "Europe/Prague" };

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../fixtures/migrations/timed/${name}.json`, import.meta.url)), "utf8"));
}

function withSchedule(schedule: Record<string, unknown>): Record<string, unknown> {
  return { ...fixture("legacy-interval"), schedule };
}

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
}

describe("known persisted timed-task migrations", () => {
  it("converts a historical interval without modifying IDs, timestamps, history, or extensions", () => {
    const original = fixture("legacy-interval");
    const before = structuredClone(original);
    freezeDeep(original);

    const result = migrateLegacyTimedTask(original, options);

    expect(result.migrated).toBe(true);
    expect(result.changes).toContain("schedule.intervalMs -> schedule.every (day-start grid)");
    expect(result.task.schedule).toEqual({
      type: "interval",
      every: { hours: 24, minutes: 0 },
      offsetFromDayStart: { hours: 18, minutes: 0 },
      timezone: "Europe/Prague",
      extension: { keep: "schedule" },
    });
    expect(result.task).toMatchObject({
      taskId: original.taskId,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      lastRunAt: original.lastRunAt,
      messageHistory: original.messageHistory,
      messageSummary: original.messageSummary,
      extension: original.extension,
      messageDedupEnabled: true,
    });
    expect(original).toEqual(before);
  });

  it("preserves a one-time task's exact runAt, even when the date is in the past", () => {
    const original = fixture("legacy-once");
    freezeDeep(original);

    const result = migrateLegacyTimedTask(original, options);

    expect(result.task.schedule).toEqual({
      type: "once",
      runAt: "2026-04-09T17:35:00.000Z",
      offsetFromDayStart: { hours: 0, minutes: 0 },
      timezone: "Europe/Prague",
      extension: { keep: "schedule" },
    });
    expect(result.task.updatedAt).toBe(original.updatedAt);
  });

  it("does not apply the legacy once offset to runAt, matching the old executor", () => {
    const original = fixture("legacy-once");
    const schedule = original.schedule as Record<string, unknown>;
    const result = migrateLegacyTimedTask({ ...original, schedule: { ...schedule, offsetMinutes: 90 } }, options);

    expect(result.task.schedule).toMatchObject({ runAt: schedule.runAt });
    expect(result.task.schedule).not.toHaveProperty("offsetMinutes");
  });

  it.each(["legacy-once", "legacy-interval", "modern-before-dedup"])("is repeatable for %s", name => {
    const first = migrateLegacyTimedTask(fixture(name), options);
    const second = migrateLegacyTimedTask(first.task, options);

    expect(second).toEqual({ task: first.task, migrated: false, changes: [] });
  });

  it("only backfills deduplication for the already modern historical shape", () => {
    const original = fixture("modern-before-dedup");
    const result = migrateLegacyTimedTask(original, options);

    expect(result.changes).toEqual(["messageDedupEnabled"]);
    expect(result.task).toEqual({ ...original, messageDedupEnabled: true });
  });

  it("keeps an explicit deduplication preference and requires no write", () => {
    const original = { ...fixture("modern-before-dedup"), messageDedupEnabled: false };
    const result = migrateLegacyTimedTask(original, options);

    expect(result.task).toEqual(original);
    expect(result.migrated).toBe(false);
  });

  it("does not reset a modern interval when only its timezone is missing", () => {
    const result = migrateLegacyTimedTask(withSchedule({
      type: "interval",
      every: { hours: 6, minutes: 30, extension: "keep" },
      offsetFromDayStart: { hours: 0, minutes: 15, extension: "keep" },
    }), options);

    expect(result.task.schedule).toEqual({
      type: "interval",
      every: { hours: 6, minutes: 30, extension: "keep" },
      offsetFromDayStart: { hours: 0, minutes: 15, extension: "keep" },
      timezone: "Europe/Prague",
    });
  });

  it("fills the old missing offset with zero", () => {
    const result = migrateLegacyTimedTask(withSchedule({
      type: "interval",
      intervalMs: 300_000,
    }), options);

    expect(result.task.schedule).toMatchObject({
      every: { hours: 0, minutes: 5 },
      offsetFromDayStart: { hours: 0, minutes: 0 },
    });
  });

  it("cleans a matching mixed format without changing its values", () => {
    const result = migrateLegacyTimedTask(withSchedule({
      type: "interval",
      every: { hours: 1, minutes: 30 },
      intervalMs: 5_400_000,
      offsetFromDayStart: { hours: 0, minutes: 15 },
      offsetMinutes: 15,
      timezone: "UTC",
    }), options);

    expect(result.task.schedule).toEqual({
      type: "interval",
      every: { hours: 1, minutes: 30 },
      offsetFromDayStart: { hours: 0, minutes: 15 },
      timezone: "UTC",
    });
  });

  it.each([5_000, 90_000, 86_460_000, 0, -60_000, NaN, Infinity, "60000"])(
    "rejects a legacy interval that cannot be represented exactly: %s",
    intervalMs => {
      expect(() => migrateLegacyTimedTask(withSchedule({ type: "interval", intervalMs }), options)).toThrow("Cannot migrate timed task");
    },
  );

  it.each([-1, 1440, 0.5, null])("rejects an invalid or multi-day offset: %s", offsetMinutes => {
    expect(() => migrateLegacyTimedTask(withSchedule({
      type: "interval", intervalMs: 60_000, offsetMinutes,
    }), options)).toThrow("schedule.offsetMinutes");
  });

  it("rejects conflicting modern and old interval values", () => {
    expect(() => migrateLegacyTimedTask(withSchedule({
      type: "interval",
      every: { hours: 1, minutes: 0 },
      intervalMs: 60_000,
    }), options)).toThrow("schedule.every conflicts");
  });

  it("rejects conflicting modern and old offset values", () => {
    expect(() => migrateLegacyTimedTask(withSchedule({
      type: "interval",
      intervalMs: 60_000,
      offsetFromDayStart: { hours: 1, minutes: 0 },
      offsetMinutes: 0,
    }), options)).toThrow("schedule.offsetFromDayStart conflicts");
  });

  it("does not invent a one-time date when runAt is missing", () => {
    expect(() => migrateLegacyTimedTask(withSchedule({
      type: "once", offsetMinutes: 60,
    }), options)).toThrow("one-time schedule has no runAt");
  });

  it.each([
    { type: "scheduled", intervalMinutes: 60, startHour: null, startMinute: null, runOnce: false },
    { type: "cron", expression: "0 * * * *" },
  ])("rejects an unsupported historical shape", schedule => {
    expect(() => migrateLegacyTimedTask(withSchedule(schedule), options)).toThrow("unsupported schedule type");
  });

  it("validates the complete task before returning a conversion", () => {
    const original = { ...fixture("legacy-interval"), instructions: "", notifyUser: "yes" };
    freezeDeep(original);
    expect(() => migrateLegacyTimedTask(original, options)).toThrow("instructions");
    expect(original.schedule).toHaveProperty("intervalMs", 86_400_000);
  });

  it("does not include stored values in validation errors", () => {
    const secret = "private-value-that-must-not-appear";
    try {
      migrateLegacyTimedTask({ ...fixture("legacy-interval"), lastRunStatus: secret }, options);
      throw new Error("Expected validation failure");
    } catch (error) {
      expect((error as Error).message).toContain("lastRunStatus");
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([null, [], "task", {}, { schedule: null }])("rejects a malformed document", raw => {
    expect(() => migrateLegacyTimedTask(raw, options)).toThrow("expected an object with a schedule");
  });

  it("rejects an invalid timezone without falling back silently", () => {
    expect(() => migrateLegacyTimedTask(withSchedule({
      type: "interval", intervalMs: 60_000, timezone: "Mars/Olympus",
    }), options)).toThrow("schedule.timezone is not supported");
  });
});
