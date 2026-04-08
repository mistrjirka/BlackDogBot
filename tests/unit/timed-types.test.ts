import { describe, it, expect } from "vitest";
import { Schedule, IScheduleOnce, IScheduleInterval } from "../../src/shared/types/cron.types.js";
import { scheduleSchema, scheduleOnceSchema, scheduleIntervalSchema, scheduleCronSchema } from "../../src/shared/schemas/cron.schemas.js";

describe("Schedule Types", () => {
  it("should allow once type with runAt", () => {
    const schedule: IScheduleOnce = { type: "once", runAt: "2026-04-08T10:00:00Z" };
    expect(schedule.type).toBe("once");
    expect(schedule.runAt).toBeDefined();
  });

  it("should allow interval type with intervalMs", () => {
    const schedule: IScheduleInterval = { type: "interval", intervalMs: 3600000 };
    expect(schedule.type).toBe("interval");
    expect(schedule.intervalMs).toBe(3600000);
  });

  it("should be a union of only once and interval", () => {
    const onceSchedule: IScheduleOnce = { type: "once", runAt: "2026-04-08T10:00:00Z" };
    const intervalSchedule: IScheduleInterval = { type: "interval", intervalMs: 3600000 };
    const schedule: Schedule = onceSchedule;
    const schedule2: Schedule = intervalSchedule;
    expect(schedule.type).toBe("once");
    expect(schedule2.type).toBe("interval");
  });
});

describe("Schedule Schema", () => {
  it("should accept once schedule with runAt", () => {
    const result = scheduleOnceSchema.safeParse({ type: "once", runAt: "2026-04-08T10:00:00Z" });
    expect(result.success).toBe(true);
  });

  it("should accept interval schedule with intervalMs", () => {
    const result = scheduleIntervalSchema.safeParse({ type: "interval", intervalMs: 3600000 });
    expect(result.success).toBe(true);
  });

  it("should NOT have scheduleCronSchema exported", () => {
    expect(scheduleCronSchema).toBeUndefined();
  });

  it("should reject cron type in scheduleSchema", () => {
    const result = scheduleSchema.safeParse({ type: "cron", expression: "0 * * * *" });
    expect(result.success).toBe(false);
  });

  it("should only accept once and interval types in scheduleSchema", () => {
    const onceResult = scheduleSchema.safeParse({ type: "once", runAt: "2026-04-08T10:00:00Z" });
    const intervalResult = scheduleSchema.safeParse({ type: "interval", intervalMs: 3600000 });
    expect(onceResult.success).toBe(true);
    expect(intervalResult.success).toBe(true);
  });
});
