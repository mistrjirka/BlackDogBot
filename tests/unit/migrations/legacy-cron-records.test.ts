import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isCompletedLegacyCronRecord } from "../../../src/migrations/legacy-cron-records.js";

const options = { fileName: "completed-once-legacy.json", defaultTimezone: "UTC" };

function fixture(): Record<string, any> {
  return JSON.parse(fs.readFileSync(new URL("../../fixtures/migrations/cron/completed-once.json", import.meta.url), "utf8"));
}

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

describe("retained completed legacy cron records", () => {
  it("recognizes a fully validated successful one-time record without changing it", () => {
    const raw = fixture();
    const before = structuredClone(raw);
    freezeDeep(raw);
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(true);
    expect(raw).toEqual(before);
    expect(raw.enabled).toBe(true);
  });

  it("uses stored completion evidence without consulting the current time", () => {
    const raw = fixture();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Recognition must not depend on the clock");
    });
    let completed: boolean;
    try {
      completed = isCompletedLegacyCronRecord(raw, options);
    } finally {
      clock.mockRestore();
    }
    expect(completed).toBe(true);
  });

  it("accepts completion at the exact scheduled time", () => {
    const raw = fixture();
    raw.lastRunAt = raw.schedule.runAt;
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(true);
  });

  it("accepts modern metadata without rewriting or importing the record", () => {
    const raw = fixture();
    raw.schedule.offsetFromDayStart = { hours: 0, minutes: 0 };
    raw.schedule.timezone = "Europe/Prague";
    raw.messageDedupEnabled = false;
    raw.extension = { keep: "original" };
    const before = JSON.stringify(raw);
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(true);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("rejects a rescheduled task whose stored completion predates runAt", () => {
    const raw = fixture();
    raw.schedule.runAt = "2026-04-08T12:10:00.000Z";
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(false);
  });

  it.each(["failure", null, "unknown"])("rejects lastRunStatus %s", lastRunStatus => {
    expect(isCompletedLegacyCronRecord({ ...fixture(), lastRunStatus }, options)).toBe(false);
  });

  it.each([undefined, "error", ""])("requires lastRunError to be explicitly null", lastRunError => {
    expect(isCompletedLegacyCronRecord({ ...fixture(), lastRunError }, options)).toBe(false);
  });

  it.each([null, undefined, "", "not-a-date", "2026-04-08", "2026-13-08T12:05:00.000Z"])(
    "rejects a missing or invalid completion timestamp",
    lastRunAt => {
      expect(isCompletedLegacyCronRecord({ ...fixture(), lastRunAt }, options)).toBe(false);
    },
  );

  it("rejects pending one-time tasks", () => {
    const raw = { ...fixture(), lastRunAt: null, lastRunStatus: null };
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(false);
  });

  it.each([
    { type: "interval", intervalMs: 60_000 },
    { type: "scheduled", intervalMinutes: 60, startHour: null, startMinute: null, runOnce: true },
    { type: "cron", expression: "0 * * * *" },
    { type: "once" },
    { type: "once", runAt: "invalid" },
    { type: "once", runAt: "2026-04-08T12:00:00.000Z", intervalMs: 60_000 },
  ])("rejects unsupported or ambiguous schedule shapes", schedule => {
    expect(isCompletedLegacyCronRecord({ ...fixture(), schedule }, options)).toBe(false);
  });

  it.each(["../escape", ".", "..", "nested/id", "nested\\id", "id\0suffix"])(
    "rejects unsafe IDs even when the supplied filename matches",
    taskId => {
      const raw = { ...fixture(), taskId };
      expect(isCompletedLegacyCronRecord(raw, { ...options, fileName: taskId + ".json" })).toBe(false);
    },
  );

  it("rejects a filename mismatch", () => {
    expect(isCompletedLegacyCronRecord(fixture(), { ...options, fileName: "different.json" })).toBe(false);
  });

  it("requires the complete task to pass schema validation", () => {
    const raw = fixture();
    delete raw.instructions;
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(false);
  });

  it("returns false without emitting invalid values in an error", () => {
    const raw = fixture();
    raw.tools = "private-value";
    expect(() => isCompletedLegacyCronRecord(raw, options)).not.toThrow();
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(false);
  });

  it.each([null, [], "task", {}, { schedule: null }])("rejects malformed documents", raw => {
    expect(isCompletedLegacyCronRecord(raw, options)).toBe(false);
  });

  it("rejects a timezone that cannot be validated", () => {
    expect(isCompletedLegacyCronRecord(fixture(), {
      ...options, defaultTimezone: "Invalid/Timezone",
    })).toBe(false);
  });
});
