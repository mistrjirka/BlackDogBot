import fs from "node:fs/promises";
import path from "node:path";

import { IScheduledTask } from "../shared/types/index.js";
import { scheduledTaskSchema } from "../shared/schemas/index.js";
import { CRON_TOOL_ALIASES } from "../shared/schemas/tool-schemas.js";
import {
  getTimedDir,
  getTimedFilePath,
  ensureDirectoryExistsAsync,
} from "../utils/paths.js";
import { LoggerService } from "./logger.service.js";
import { ConfigService } from "./config.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import type { ITimeParts } from "../shared/types/index.js";

//#region Const

const DEFAULT_MAX_PARALLEL_CRONS: number = 1;
const DEFAULT_CRON_QUEUE_SIZE: number = 3;
const LEGACY_WRITE_TOOL_NAMES: readonly string[] = ["write_to_database", "write_database"];

//#endregion Const

//#region Interfaces

interface IQueuedTask {
  task: IScheduledTask;
  executeCallback: () => Promise<void>;
}

interface ILegacyWriteToolMigrationResult {
  task: IScheduledTask;
  changed: boolean;
  replacedTools: string[];
  addedWriteTableTools: number;
}

interface IIntervalScheduleLegacy {
  type: "interval";
  intervalMs?: number;
  offsetMinutes?: number;
  every?: ITimeParts;
  offsetFromDayStart?: ITimeParts;
  timezone?: string;
}

interface IEveryGridParts {
  minutes: number;
}

//#endregion Interfaces

export class SchedulerService {
  //#region Data members

  private static _instance: SchedulerService | null;
  private _logger: LoggerService;
  private _tasks: Map<string, IScheduledTask>;
  private _taskExecutor: ((task: IScheduledTask) => Promise<void>) | null;
  private _onTaskFailure: ((task: IScheduledTask, error: string) => Promise<void>) | null;
  private _onTaskSkipped: ((task: IScheduledTask, reason: string) => Promise<void>) | null;
  private _intervals: Map<string, NodeJS.Timeout>;
  private _timeouts: Map<string, NodeJS.Timeout>;

  // Concurrency control
  private _maxParallelCrons: number;
  private _cronQueueSize: number;
  private _runningTaskCount: number;
  private _taskQueue: IQueuedTask[];

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._tasks = new Map();
    this._taskExecutor = null;
    this._onTaskFailure = null;
    this._onTaskSkipped = null;
    this._intervals = new Map();
    this._timeouts = new Map();

    // Concurrency control — defaults, overridden in startAsync from config
    this._maxParallelCrons = DEFAULT_MAX_PARALLEL_CRONS;
    this._cronQueueSize = DEFAULT_CRON_QUEUE_SIZE;
    this._runningTaskCount = 0;
    this._taskQueue = [];
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): SchedulerService {
    if (!SchedulerService._instance) {
      SchedulerService._instance = new SchedulerService();
    }

    return SchedulerService._instance;
  }

  public setTaskExecutor(
    executor: (task: IScheduledTask) => Promise<void>,
  ): void {
    this._taskExecutor = executor;
  }

  public setOnTaskFailure(
    callback: (task: IScheduledTask, error: string) => Promise<void>,
  ): void {
    this._onTaskFailure = callback;
  }

  public setOnTaskSkipped(
    callback: (task: IScheduledTask, reason: string) => Promise<void>,
  ): void {
    this._onTaskSkipped = callback;
  }

  /** Number of cron tasks currently executing. */
  public getRunningTaskCount(): number {
    return this._runningTaskCount;
  }

  /** Number of cron tasks waiting in the queue. */
  public getQueuedTaskCount(): number {
    return this._taskQueue.length;
  }

  public async startAsync(): Promise<void> {
    await ensureDirectoryExistsAsync(getTimedDir());
    await this._loadAllTasksAsync();

    // Read concurrency settings from config
    const config = ConfigService.getInstance().getConfig();
    this._maxParallelCrons = config.scheduler.maxParallelCrons ?? DEFAULT_MAX_PARALLEL_CRONS;
    this._cronQueueSize = config.scheduler.cronQueueSize ?? DEFAULT_CRON_QUEUE_SIZE;

    for (const task of this._tasks.values()) {
      if (task.enabled) {
        this._scheduleTask(task);
      }
    }

    this._logger.info("Scheduler started", {
      totalTasks: this._tasks.size,
      enabledTasks: this.getTasksByEnabled(true).length,
      maxParallelCrons: this._maxParallelCrons,
      cronQueueSize: this._cronQueueSize,
    });
  }

  public async stopAsync(): Promise<void> {
    for (const [taskId, intervalId] of this._intervals) {
      clearInterval(intervalId);
      this._intervals.delete(taskId);
    }

    for (const [taskId, timeoutId] of this._timeouts) {
      clearTimeout(timeoutId);
      this._timeouts.delete(taskId);
    }

    this._intervals.clear();
    this._timeouts.clear();

    // Clear the queue on stop — queued tasks are abandoned
    this._taskQueue = [];

    this._logger.info("Scheduler stopped");
  }

  public async addTaskAsync(task: IScheduledTask): Promise<void> {
    const validatedTask: IScheduledTask = scheduledTaskSchema.parse(task);

    await this._saveTaskAsync(validatedTask);
    this._tasks.set(validatedTask.taskId, validatedTask);

    if (validatedTask.enabled) {
      this._scheduleTask(validatedTask);
    }

    this._logger.info("Task added", { taskId: validatedTask.taskId, name: validatedTask.name });
  }

  public async removeTaskAsync(taskId: string): Promise<void> {
    this._unscheduleTask(taskId);
    this._tasks.delete(taskId);

    // Remove any queued instances of this task
    this._taskQueue = this._taskQueue.filter(
      (queued: IQueuedTask) => queued.task.taskId !== taskId,
    );

    const filePath: string = getTimedFilePath(taskId);

    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      this._logger.warn("Failed to delete task file", {
        taskId,
        error: extractErrorMessage(error),
      });
    }

    this._logger.info("Task removed", { taskId });
  }

  public async setTaskEnabledAsync(taskId: string, enabled: boolean): Promise<boolean> {
    const task: IScheduledTask | undefined = this._tasks.get(taskId);

    if (!task) {
      return false;
    }

    task.enabled = enabled;
    task.updatedAt = new Date().toISOString();
    this._tasks.set(taskId, task);
    await this._saveTaskAsync(task);

    if (enabled) {
      this._scheduleTask(task);
    } else {
      this._unscheduleTask(taskId);
    }

    this._logger.info("Task enabled state changed", { taskId, enabled });
    return true;
  }

  public async updateTaskAsync(
    taskId: string,
    patch: Partial<IScheduledTask>,
  ): Promise<IScheduledTask | undefined> {
    const task: IScheduledTask | undefined = this._tasks.get(taskId);

    if (!task) {
      return undefined;
    }

    const scheduleChanged: boolean =
      patch.schedule !== undefined &&
      JSON.stringify(patch.schedule) !== JSON.stringify(task.schedule);

    const enabledChanged: boolean =
      patch.enabled !== undefined && patch.enabled !== task.enabled;

    Object.assign(task, patch);
    task.updatedAt = new Date().toISOString();

    const validatedTask: IScheduledTask = scheduledTaskSchema.parse(task);

    this._tasks.set(taskId, validatedTask);
    await this._saveTaskAsync(validatedTask);

    if (enabledChanged || scheduleChanged) {
      this._unscheduleTask(taskId);
      if (validatedTask.enabled) {
        this._scheduleTask(validatedTask);
      }
    }

    this._logger.info("Task updated", { taskId, name: validatedTask.name });
    return validatedTask;
  }

  public async removeAllTasksAsync(): Promise<void> {
    const taskIds: string[] = Array.from(this._tasks.keys());

    for (const taskId of taskIds) {
      await this.removeTaskAsync(taskId);
    }

    this._logger.info("All scheduled tasks removed");
  }

  public async getTaskAsync(
    taskId: string,
  ): Promise<IScheduledTask | undefined> {
    return this._tasks.get(taskId);
  }

  public getAllTasks(): IScheduledTask[] {
    return Array.from(this._tasks.values());
  }

  public getTasksByEnabled(enabledOnly: boolean): IScheduledTask[] {
    return Array.from(this._tasks.values()).filter(
      (task: IScheduledTask) => task.enabled === enabledOnly,
    );
  }

  //#endregion Public methods

  //#region Private methods

  private async _loadAllTasksAsync(): Promise<void> {
    const timedDir: string = getTimedDir();

    let entries: string[];

    try {
      entries = await fs.readdir(timedDir);
    } catch (error: unknown) {
      this._logger.warn("Failed to read timed directory", {
        timedDir,
        error: extractErrorMessage(error),
      });
      return;
    }

    const jsonFiles: string[] = entries.filter((entry: string) =>
      entry.endsWith(".json"),
    );

    // Build per-table write tool names once to migrate legacy generic write tools
    // in existing persisted timed tasks.
    let perTableWriteToolNames: string[] = [];
    const perTableResult = await buildPerTableToolsAsync();
    if (perTableResult.dbStatus === "corrupt") {
      this._logger.warn("Database corrupt - per-table tools unavailable for timed migration", {
        dbStatus: perTableResult.dbStatus,
      });
    }
    perTableWriteToolNames = Object.keys(perTableResult.tools)
      .filter((name: string): boolean => name.startsWith("write_table_"))
      .sort();

    const migratedTasks: string[] = [];

    for (const fileName of jsonFiles) {
      const filePath: string = path.join(timedDir, fileName);

      try {
        const content: string = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);

        // Migrate legacy interval/offset format to every/offsetFromDayStart format.
        const migrationResult = await this._migrateLegacyTimedScheduleFields(parsed, filePath);
        let task: IScheduledTask = scheduledTaskSchema.parse(migrationResult.task);

        if (migrationResult.migrated) {
          this._logger.info("Migrated legacy timed task schedule fields", {
            taskId: task.taskId,
            name: task.name,
          });
        }

        const writeToolsMigration = this._migrateLegacyWriteTools(task, perTableWriteToolNames);
        if (writeToolsMigration.changed) {
          await fs.writeFile(filePath, JSON.stringify(writeToolsMigration.task, null, 2), "utf-8");

          this._logger.info("Migrated legacy write timed tools to per-table tools", {
            taskId: writeToolsMigration.task.taskId,
            name: writeToolsMigration.task.name,
            replacedTools: writeToolsMigration.replacedTools,
            addedWriteTableTools: writeToolsMigration.addedWriteTableTools,
          });
        }

        const effectiveTask: IScheduledTask = writeToolsMigration.task;

        // Check for deprecated tool names
        const deprecatedTools: string[] = effectiveTask.tools.filter(
          (name: string) => name in CRON_TOOL_ALIASES,
        );
        if (deprecatedTools.length > 0) {
          migratedTasks.push(`${effectiveTask.name} (${effectiveTask.taskId}): ${deprecatedTools.join(", ")}`);
        }

        this._tasks.set(effectiveTask.taskId, effectiveTask);
      } catch (error: unknown) {
        this._logger.warn("Failed to parse task file, skipping", {
          filePath,
          error: extractErrorMessage(error),
        });
      }
    }

    if (migratedTasks.length > 0) {
      this._logger.warn(
        `${migratedTasks.length} timed task(s) use deprecated tool names that will be auto-expanded at runtime:`,
        { tasks: migratedTasks },
      );
    }
  }

  private _migrateLegacyWriteTools(
    task: IScheduledTask,
    perTableWriteToolNames: readonly string[],
  ): ILegacyWriteToolMigrationResult {
    const replacedTools: string[] = task.tools.filter((name: string): boolean =>
      LEGACY_WRITE_TOOL_NAMES.includes(name),
    );

    if (replacedTools.length === 0) {
      return {
        task,
        changed: false,
        replacedTools: [],
        addedWriteTableTools: 0,
      };
    }

    if (perTableWriteToolNames.length === 0) {
      this._logger.warn("Legacy write timed tools detected but no write_table_* tools exist yet", {
        taskId: task.taskId,
        name: task.name,
        replacedTools,
      });

      return {
        task,
        changed: false,
        replacedTools,
        addedWriteTableTools: 0,
      };
    }

    const withoutLegacy: string[] = task.tools.filter((name: string): boolean =>
      !LEGACY_WRITE_TOOL_NAMES.includes(name),
    );
    const mergedTools: string[] = Array.from(new Set([...withoutLegacy, ...perTableWriteToolNames]));

    const migratedTask: IScheduledTask = {
      ...task,
      tools: mergedTools,
      updatedAt: new Date().toISOString(),
    };

    return {
      task: migratedTask,
      changed: true,
      replacedTools,
      addedWriteTableTools: perTableWriteToolNames.length,
    };
  }

  private _parseLegacyEvery(intervalMs: number): ITimeParts {
    const totalMinutes: number = Math.max(1, Math.floor(intervalMs / 60000));
    return {
      hours: Math.floor(totalMinutes / 60),
      minutes: totalMinutes % 60,
    };
  }

  private _parseLegacyOffset(offsetMinutes: number): ITimeParts {
    const safeOffset: number = Math.max(0, Math.floor(offsetMinutes));
    return {
      hours: Math.floor(safeOffset / 60),
      minutes: safeOffset % 60,
    };
  }

  private _normalizeEvery(parts: ITimeParts): IEveryGridParts {
    const totalMinutes: number = (parts.hours * 60) + parts.minutes;
    return {
      minutes: Math.max(1, totalMinutes),
    };
  }

  private _normalizeOffsetFromDayStart(parts: ITimeParts): ITimeParts {
    const totalMinutes: number = Math.max(0, (parts.hours * 60) + parts.minutes);
    const withinDayMinutes: number = totalMinutes % (24 * 60);
    return {
      hours: Math.floor(withinDayMinutes / 60),
      minutes: withinDayMinutes % 60,
    };
  }

  private _resolveScheduleTimezone(rawTimezone?: unknown): string {
    if (typeof rawTimezone === "string" && rawTimezone.trim().length > 0) {
      return rawTimezone;
    }

    const configuredTimezone: string = ConfigService.getInstance().getConfig().scheduler.timezone ?? "UTC";

    try {
      Intl.DateTimeFormat("en-US", { timeZone: configuredTimezone }).format(new Date());
      return configuredTimezone;
    } catch {
      return "UTC";
    }
  }

  private _getLocalMidnightUtcMs(localDate: string, timezone: string): number {
    const referenceMs: number = Date.parse(`${localDate}T00:00:00Z`);

    if (!Number.isFinite(referenceMs)) {
      return referenceMs;
    }

    const formatter: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    });

    const parts: Intl.DateTimeFormatPart[] = formatter.formatToParts(new Date(referenceMs));
    const timeZonePart: Intl.DateTimeFormatPart | undefined = parts.find(
      (p: Intl.DateTimeFormatPart) => p.type === "timeZoneName",
    );

    if (!timeZonePart || !timeZonePart.value) {
      return referenceMs;
    }

    const offsetStr: string = timeZonePart.value;
    const offsetMatch: RegExpMatchArray | null = offsetStr.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);

    if (!offsetMatch) {
      return referenceMs;
    }

    const sign: number = offsetMatch[1] === "+" ? 1 : -1;
    const offsetHours: number = parseInt(offsetMatch[2], 10);
    const offsetMinutes: number = offsetMatch[3] ? parseInt(offsetMatch[3], 10) : 0;
    const totalOffsetMinutes: number = sign * ((offsetHours * 60) + offsetMinutes);
    const offsetMs: number = totalOffsetMinutes * 60 * 1000;

    return referenceMs - offsetMs;
  }

  private _resolveNextIntervalSlotMs(task: IScheduledTask): number {
    if (task.schedule.type !== "interval") {
      return 0;
    }

    const schedule = task.schedule;
    const normalizedEvery: IEveryGridParts = this._normalizeEvery(schedule.every);
    const normalizedOffset: ITimeParts = this._normalizeOffsetFromDayStart(schedule.offsetFromDayStart);
    const everyMinutes: number = normalizedEvery.minutes;
    const everyMs: number = everyMinutes * 60000;
    const offsetMinutes: number = (normalizedOffset.hours * 60) + normalizedOffset.minutes;
    const offsetMs: number = offsetMinutes * 60000;

    const timezone: string = schedule.timezone || this._resolveScheduleTimezone(undefined);
    const nowMs: number = Date.now();

    let formatter: Intl.DateTimeFormat;

    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }

    const nowLocalDate: string = formatter.format(new Date(nowMs));
    const dayStartUtcMs: number = this._getLocalMidnightUtcMs(nowLocalDate, timezone);

    if (!Number.isFinite(dayStartUtcMs)) {
      return nowMs + everyMs;
    }

    const dayMs: number = 24 * 60 * 60 * 1000;
    const firstSlotMs: number = dayStartUtcMs + offsetMs;

    if (nowMs <= firstSlotMs) {
      return firstSlotMs;
    }

    const elapsedSinceFirst: number = nowMs - firstSlotMs;
    const increments: number = Math.floor(elapsedSinceFirst / everyMs) + 1;
    const nextSlotSameDay: number = firstSlotMs + (increments * everyMs);

    if (nextSlotSameDay < dayStartUtcMs + dayMs) {
      return nextSlotSameDay;
    }

    return firstSlotMs + dayMs;
  }

  private async _migrateLegacyTimedScheduleFields(
    rawParsed: unknown,
    filePath: string,
  ): Promise<{ task: unknown; migrated: boolean }> {
    const raw = rawParsed as Record<string, unknown>;
    const rawSchedule = raw.schedule as IIntervalScheduleLegacy | undefined;

    if (!rawSchedule || (rawSchedule.type !== "interval" && rawSchedule.type !== "once")) {
      return { task: rawParsed, migrated: false };
    }

    if (rawSchedule.type === "interval") {
      const hasModernIntervalFields: boolean =
        rawSchedule.every !== undefined
        && rawSchedule.offsetFromDayStart !== undefined
        && typeof rawSchedule.timezone === "string"
        && rawSchedule.timezone.length > 0;

      if (hasModernIntervalFields) {
        return { task: rawParsed, migrated: false };
      }

      const intervalMs: number = typeof rawSchedule.intervalMs === "number" && rawSchedule.intervalMs > 0
        ? rawSchedule.intervalMs
        : 60000;

      const offsetMinutes: number = typeof rawSchedule.offsetMinutes === "number" && rawSchedule.offsetMinutes >= 0
        ? rawSchedule.offsetMinutes
        : 0;

      const migratedTask: Record<string, unknown> = {
        ...raw,
        schedule: {
          type: "interval",
          every: this._parseLegacyEvery(intervalMs),
          offsetFromDayStart: this._parseLegacyOffset(offsetMinutes),
          timezone: this._resolveScheduleTimezone(rawSchedule.timezone),
        },
        updatedAt: new Date().toISOString(),
      };

      const normalizedSchedule = migratedTask.schedule as {
        every: ITimeParts;
        offsetFromDayStart: ITimeParts;
      };

      normalizedSchedule.every = this._parseLegacyEvery(intervalMs);
      normalizedSchedule.offsetFromDayStart = this._normalizeOffsetFromDayStart(this._parseLegacyOffset(offsetMinutes));

      await fs.writeFile(filePath, JSON.stringify(migratedTask, null, 2), "utf-8");
      return { task: migratedTask, migrated: true };
    }

    const onceSchedule = rawSchedule as { offsetFromDayStart?: ITimeParts; timezone?: string };
    const hasModernOnceFields: boolean =
      onceSchedule.offsetFromDayStart !== undefined
      && typeof onceSchedule.timezone === "string"
      && onceSchedule.timezone.length > 0;

    if (hasModernOnceFields) {
      return { task: rawParsed, migrated: false };
    }

    const migratedTask: Record<string, unknown> = {
      ...raw,
      schedule: {
        ...(rawSchedule as unknown as Record<string, unknown>),
        offsetFromDayStart: {
          hours: 0,
          minutes: 0,
        },
        timezone: this._resolveScheduleTimezone(rawSchedule.timezone),
      },
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(filePath, JSON.stringify(migratedTask, null, 2), "utf-8");

    return { task: migratedTask, migrated: true };
  }

  private async _saveTaskAsync(task: IScheduledTask): Promise<void> {
    const filePath: string = getTimedFilePath(task.taskId);

    await ensureDirectoryExistsAsync(getTimedDir());
    await fs.writeFile(filePath, JSON.stringify(task, null, 2), "utf-8");
  }

  /**
   * Attempts to run the callback immediately if below concurrency limit,
   * otherwise enqueues it. If the queue is full, the task is skipped
   * and the onTaskSkipped callback is fired.
   */
  private _dispatchOrEnqueue(task: IScheduledTask, executeCallback: () => Promise<void>): void {
    if (this._runningTaskCount < this._maxParallelCrons) {
      this._executeWithConcurrencyTracking(task, executeCallback);
      return;
    }

    // At concurrency limit — try to enqueue
    if (this._taskQueue.length < this._cronQueueSize) {
      this._taskQueue.push({ task, executeCallback });

      this._logger.warn("Task queued (concurrency limit reached)", {
        taskId: task.taskId,
        name: task.name,
        runningTasks: this._runningTaskCount,
        queueLength: this._taskQueue.length,
        maxParallelCrons: this._maxParallelCrons,
        cronQueueSize: this._cronQueueSize,
      });
      return;
    }

    // Queue is full — skip the task
    const reason: string =
      `Concurrency limit reached (${this._runningTaskCount}/${this._maxParallelCrons} running, ` +
      `${this._taskQueue.length}/${this._cronQueueSize} queued). Task skipped.`;

    this._logger.warn("Task skipped (queue full)", {
      taskId: task.taskId,
      name: task.name,
      runningTasks: this._runningTaskCount,
      queueLength: this._taskQueue.length,
      maxParallelCrons: this._maxParallelCrons,
      cronQueueSize: this._cronQueueSize,
    });

    if (this._onTaskSkipped) {
      this._onTaskSkipped(task, reason).catch((error: unknown) => {
        this._logger.error("Failed to send task-skipped notification", {
          taskId: task.taskId,
          error: extractErrorMessage(error),
        });
      });
    }
  }

  /**
   * Wraps executeCallback with running-task tracking.
   * On completion (success or failure), decrements the counter and drains the queue.
   */
  private _executeWithConcurrencyTracking(
    task: IScheduledTask,
    executeCallback: () => Promise<void>,
  ): void {
    this._runningTaskCount++;

    this._logger.info("Task dispatched", {
      taskId: task.taskId,
      name: task.name,
      runningTasks: this._runningTaskCount,
      queueLength: this._taskQueue.length,
    });

    executeCallback()
      .finally(() => {
        this._runningTaskCount--;

        this._logger.info("Task finished", {
          taskId: task.taskId,
          name: task.name,
          runningTasks: this._runningTaskCount,
          queueLength: this._taskQueue.length,
        });

        // Drain the queue
        this._drainQueue();
      });
  }

  /** Dequeues and dispatches tasks while below the concurrency limit. */
  private _drainQueue(): void {
    while (this._runningTaskCount < this._maxParallelCrons && this._taskQueue.length > 0) {
      const next: IQueuedTask = this._taskQueue.shift()!;

      this._logger.info("Dequeuing task", {
        taskId: next.task.taskId,
        name: next.task.name,
        remainingQueue: this._taskQueue.length,
      });

      this._executeWithConcurrencyTracking(next.task, next.executeCallback);
    }
  }

  private _scheduleTask(task: IScheduledTask): void {
    const executeCallback = async (): Promise<void> => {
      this._logger.info("Task starting", {
        taskId: task.taskId,
        name: task.name,
      });

      try {
        if (this._taskExecutor) {
          await this._taskExecutor(task);
        }

        task.lastRunAt = new Date().toISOString();
        task.lastRunStatus = "success";
        task.lastRunError = null;
        this._tasks.set(task.taskId, task);
        await this._saveTaskAsync(task);
      } catch (error: unknown) {
        const errorMessage: string =
          extractErrorMessage(error);

        task.lastRunAt = new Date().toISOString();
        task.lastRunStatus = "failure";
        task.lastRunError = errorMessage;
        this._tasks.set(task.taskId, task);
        await this._saveTaskAsync(task);

        this._logger.error("Task execution failed", {
          taskId: task.taskId,
          error: errorMessage,
        });

        if (this._onTaskFailure) {
          try {
            await this._onTaskFailure(task, errorMessage);
          } catch (notifyError) {
            this._logger.error("Failed to send task failure notification", {
              taskId: task.taskId,
              error: notifyError instanceof Error ? notifyError.message : String(notifyError),
            });
          }
        }
      }
    };

    const schedule = task.schedule;

    switch (schedule.type) {
      case "interval": {
        const scheduleNextRun = (): void => {
          const nextRunAtMs: number = this._resolveNextIntervalSlotMs(task);
          const delayMs: number = Math.max(0, nextRunAtMs - Date.now());

          const timeoutId: NodeJS.Timeout = setTimeout(() => {
            this._dispatchOrEnqueue(task, executeCallback);
            this._timeouts.delete(task.taskId);
            scheduleNextRun();
          }, delayMs);

          this._timeouts.set(task.taskId, timeoutId);
        };

        scheduleNextRun();

        this._logger.debug("Scheduled interval task", {
          taskId: task.taskId,
          every: schedule.every,
          offsetFromDayStart: schedule.offsetFromDayStart,
          timezone: schedule.timezone,
        });
        break;
      }

      case "once": {
        const runAtDate: Date = new Date(schedule.runAt);
        const delayMs: number = runAtDate.getTime() - Date.now();

        if (delayMs <= 0) {
          this._logger.warn("Scheduled time has already passed, skipping", {
            taskId: task.taskId,
            runAt: schedule.runAt,
          });
          return;
        }

        const timeoutId: NodeJS.Timeout = setTimeout(() => {
          this._dispatchOrEnqueue(task, executeCallback);
          this._timeouts.delete(task.taskId);
        }, delayMs);

        this._timeouts.set(task.taskId, timeoutId);
        this._logger.debug("Scheduled one-time task", {
          taskId: task.taskId,
          runAt: schedule.runAt,
        });
        break;
      }
    }
  }

  private _unscheduleTask(taskId: string): void {
    const intervalId: NodeJS.Timeout | undefined =
      this._intervals.get(taskId);

    if (intervalId) {
      clearInterval(intervalId);
      this._intervals.delete(taskId);
    }

    const timeoutId: NodeJS.Timeout | undefined =
      this._timeouts.get(taskId);

    if (timeoutId) {
      clearTimeout(timeoutId);
      this._timeouts.delete(taskId);
    }
  }

  //#endregion Private methods
}
