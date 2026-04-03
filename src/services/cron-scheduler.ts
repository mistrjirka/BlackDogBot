interface IScheduledJob {
  id: string;
  intervalMinutes: number;
  startHour: number | null;
  startMinute: number | null;
  timezone: string | undefined;
  callback: () => void;
  nextRunTime: Date | null;
}

/**
 * A single-tick scheduler that evaluates ALL registered jobs on every tick.
 *
 * Uses interval-based scheduling (intervalMinutes + optional startHour/startMinute)
 * instead of cron expressions to eliminate LLM confusion with cron syntax.
 *
 * One setInterval fires once per second and iterates all jobs. Jobs scheduled
 * for the same time fire in the same event loop iteration — no races, no drift.
 */
export class CronScheduler {
  private _jobs: Map<string, IScheduledJob> = new Map();
  private _tickInterval: NodeJS.Timeout | null = null;

  start(tickMs = 1000): void {
    if (this._tickInterval !== null) return;
    this._tickInterval = setInterval(() => this._tick(), tickMs);
  }

  stop(): void {
    if (this._tickInterval !== null) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    this._jobs.clear();
  }

  addScheduledJob(
    id: string,
    intervalMinutes: number,
    startHour: number | null,
    startMinute: number | null,
    timezone: string | undefined,
    callback: () => void,
  ): Date | null {
    const nextRunTime = this._calculateNextRun(intervalMinutes, startHour, startMinute);
    const job: IScheduledJob = {
      id,
      intervalMinutes,
      startHour,
      startMinute,
      timezone,
      callback,
      nextRunTime,
    };
    this._jobs.set(id, job);
    return nextRunTime;
  }

  removeJob(id: string): void {
    this._jobs.delete(id);
  }

  getNextRun(id: string): Date | null {
    return this._jobs.get(id)?.nextRunTime ?? null;
  }

  /** Exposed for testing — directly invoke a tick cycle. */
  tick(): void {
    this._tick();
  }

  private _tick(): void {
    const now = new Date();

    for (const job of this._jobs.values()) {
      if (job.nextRunTime !== null && now >= job.nextRunTime) {
        job.callback();
        job.nextRunTime = this._calculateNextRun(
          job.intervalMinutes,
          job.startHour,
          job.startMinute,
          job.nextRunTime,
        );
      }
    }
  }

  private _calculateNextRun(
    intervalMinutes: number,
    startHour: number | null,
    startMinute: number | null,
    after?: Date,
  ): Date {
    const now = after ?? new Date();

    if (startHour === null && startMinute === null) {
      // No phase anchor: just add interval to the reference time
      return new Date(now.getTime() + intervalMinutes * 60_000);
    }

    // Build a candidate at the next occurrence of startHour:startMinute
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);

    if (startHour !== null) {
      candidate.setHours(startHour);
    }

    if (startMinute !== null) {
      candidate.setMinutes(startMinute);
    } else {
      candidate.setMinutes(0);
    }

    // If candidate is at or before "now", advance by intervals until it's in the future
    const intervalMs = intervalMinutes * 60_000;

    if (candidate.getTime() <= now.getTime()) {
      if (intervalMinutes >= 1440) {
        // Daily or multi-day: advance by full intervals
        const elapsed = now.getTime() - candidate.getTime();
        const intervals = Math.ceil(elapsed / intervalMs);
        candidate.setTime(candidate.getTime() + intervals * intervalMs);
      } else {
        // Sub-daily: advance by interval until we pass "now"
        while (candidate.getTime() <= now.getTime()) {
          candidate.setTime(candidate.getTime() + intervalMs);
        }
      }
    }

    return candidate;
  }
}
