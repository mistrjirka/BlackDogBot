import { Cron } from "croner";

interface ICronJob {
  id: string;
  expression: string;
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
  private _jobs: Map<string, ICronJob> = new Map();
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

  addJob(
    id: string,
    expression: string,
    timezone: string | undefined,
    callback: () => void,
  ): Date | null {
    const nextRunTime = this._calculateNextRun(expression, timezone);
    const job: ICronJob = { id, expression, timezone, callback, nextRunTime };
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
          job.expression,
          job.timezone,
          job.nextRunTime,
        );
      }
    }
  }

  private _calculateNextRun(
    expression: string,
    timezone: string | undefined,
    after?: Date,
  ): Date | null {
    try {
      // Use croner as a pure expression parser only — no callback means no scheduling
      const parser = new Cron(expression, { timezone });
      return parser.nextRun(after) ?? null;
    } catch {
      return null;
    }
  }
}
