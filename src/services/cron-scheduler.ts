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
 * A single-tick cron scheduler that evaluates ALL registered jobs on every tick.
 *
 * This solves the fundamental flaw in per-job-timer-chain schedulers (like croner's
 * default mode): when multiple jobs share the same cron expression, each gets its
 * own independent setTimeout chain. Accumulated drift between chains means one
 * timer fires just before the target second and reschedules for tomorrow, while
 * another fires correctly. Result: silent missed jobs.
 *
 * Here, one setInterval fires once per second and iterates all jobs. Jobs scheduled
 * for the same time fire in the same event loop iteration — no races, no drift.
 * Croner is kept only as a cron expression parser (new Cron(expr).nextRun()).
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
    const nextRunTime = this._calculateNextRun(intervalMinutes, startHour, startMinute, undefined);
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
        // Advance from the scheduled time (not "now") so drift doesn't accumulate
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
  ): Date | null {
    const now = after ?? new Date();

    if (startHour === null && startMinute === null) {
      return new Date(now.getTime() + intervalMinutes * 60_000);
    }

    const candidate = new Date(now);
    candidate.setHours(startHour!, startMinute!, 0, 0);

    if (candidate <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }

    return candidate;
  }
}
