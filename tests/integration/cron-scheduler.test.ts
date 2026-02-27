import { describe, it, expect, vi, afterEach } from "vitest";

import { CronScheduler } from "../../src/services/cron-scheduler.js";

// All tests use a fixed fake time starting at an exact minute boundary so that
// cron arithmetic is deterministic regardless of when the test runs.
const FAKE_NOW = new Date("2025-01-01T00:00:00.000Z").getTime();

describe("CronScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  //#region Core firing

  it("should fire a single cron job when its next run time arrives", async () => {
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();
    const fired: string[] = [];

    scheduler.addJob("job-a", "* * * * *", undefined, () => {
      fired.push("job-a");
    });

    scheduler.start();

    // Advance 61 seconds — crosses the 00:01:00Z minute boundary
    await vi.advanceTimersByTimeAsync(61_000);

    expect(fired).toContain("job-a");

    scheduler.stop();
  });

  it("should fire ALL jobs sharing the same cron expression (the bug this fixes)", async () => {
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();
    const fired: string[] = [];

    scheduler.addJob("job-a", "* * * * *", undefined, () => { fired.push("job-a"); });
    scheduler.addJob("job-b", "* * * * *", undefined, () => { fired.push("job-b"); });
    scheduler.addJob("job-c", "* * * * *", undefined, () => { fired.push("job-c"); });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(61_000);

    // All three must have fired — previously only the first would fire
    expect(fired).toContain("job-a");
    expect(fired).toContain("job-b");
    expect(fired).toContain("job-c");

    // Each fires exactly once in one minute window
    expect(fired.filter((id) => id === "job-a")).toHaveLength(1);
    expect(fired.filter((id) => id === "job-b")).toHaveLength(1);
    expect(fired.filter((id) => id === "job-c")).toHaveLength(1);

    scheduler.stop();
  });

  //#endregion Core firing

  //#region Recurrence

  it("should fire each job on every subsequent interval", async () => {
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();
    const counts: Record<string, number> = { "job-a": 0, "job-b": 0 };

    scheduler.addJob("job-a", "* * * * *", undefined, () => { counts["job-a"]++; });
    scheduler.addJob("job-b", "* * * * *", undefined, () => { counts["job-b"]++; });

    scheduler.start();

    // Advance 3 minutes + 1 second — should cross T=60, T=120, T=180
    await vi.advanceTimersByTimeAsync(181_000);

    expect(counts["job-a"]).toBe(3);
    expect(counts["job-b"]).toBe(3);

    scheduler.stop();
  });

  it("should fire jobs with different expressions at their respective cadences", async () => {
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();
    const counts: Record<string, number> = { "every-1m": 0, "every-2m": 0 };

    // Fires at 00:01, 00:02 (2 fires in 121s window)
    scheduler.addJob("every-1m", "* * * * *", undefined, () => { counts["every-1m"]++; });
    // Fires at 00:02 only (1 fire in 121s window)
    scheduler.addJob("every-2m", "*/2 * * * *", undefined, () => { counts["every-2m"]++; });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(121_000);

    expect(counts["every-1m"]).toBe(2);
    expect(counts["every-2m"]).toBe(1);

    scheduler.stop();
  });

  //#endregion Recurrence

  //#region Control

  it("should not fire a removed job", async () => {
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();
    const fired: string[] = [];

    scheduler.addJob("job-a", "* * * * *", undefined, () => { fired.push("job-a"); });
    scheduler.addJob("job-b", "* * * * *", undefined, () => { fired.push("job-b"); });
    scheduler.removeJob("job-a");

    scheduler.start();

    await vi.advanceTimersByTimeAsync(61_000);

    expect(fired).not.toContain("job-a");
    expect(fired).toContain("job-b");

    scheduler.stop();
  });

  it("should stop firing all jobs after stop()", async () => {
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();
    const fired: string[] = [];

    scheduler.addJob("job-a", "* * * * *", undefined, () => { fired.push("job-a"); });

    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(61_000);

    expect(fired).toHaveLength(0);
  });

  //#endregion Control

  //#region tick()

  it("should fire due jobs when tick() is called directly", () => {
    // No fake timers needed — we control nextRunTime via tick timing manually
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();
    const fired: string[] = [];

    scheduler.addJob("job-a", "* * * * *", undefined, () => { fired.push("job-a"); });
    scheduler.addJob("job-b", "* * * * *", undefined, () => { fired.push("job-b"); });

    // Advance fake time to just past the first run time without setInterval running
    vi.setSystemTime(new Date("2025-01-01T00:01:01.000Z"));

    // Manually invoke a tick — both jobs should fire
    scheduler.tick();

    expect(fired).toContain("job-a");
    expect(fired).toContain("job-b");

    scheduler.stop();
  });

  //#endregion tick()

  //#region getNextRun

  it("should return the correct nextRun date for a registered job", () => {
    vi.useFakeTimers({ now: FAKE_NOW });

    const scheduler = new CronScheduler();

    scheduler.addJob("job-a", "* * * * *", undefined, () => {});

    const nextRun = scheduler.getNextRun("job-a");

    // Starting at 00:00:00Z, next "* * * * *" occurrence is 00:01:00Z
    expect(nextRun).not.toBeNull();
    expect(nextRun!.toISOString()).toBe("2025-01-01T00:01:00.000Z");

    scheduler.stop();
  });

  it("should return null for an unregistered job id", () => {
    const scheduler = new CronScheduler();

    expect(scheduler.getNextRun("nonexistent")).toBeNull();

    scheduler.stop();
  });

  //#endregion getNextRun
});
