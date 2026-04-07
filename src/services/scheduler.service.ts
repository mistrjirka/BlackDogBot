import fs from "node:fs/promises";
import path from "node:path";

import { CronScheduler } from "./cron-scheduler.js";

import { IScheduledTask } from "../shared/types/index.js";
import { scheduledTaskSchema } from "../shared/schemas/index.js";
import { CRON_TOOL_ALIASES } from "../shared/schemas/tool-schemas.js";
import {
  getCronDir,
  getCronFilePath,
  ensureDirectoryExistsAsync,
} from "../utils/paths.js";
import { LoggerService } from "./logger.service.js";
import { IScheduleScheduled } from "../shared/types/cron.types.js";
import { ConfigService } from "./config.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";

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

//#endregion Interfaces

export class SchedulerService {
  //#region Data members

  private static _instance: SchedulerService | null;
  private _logger: LoggerService;
  private _cronScheduler: CronScheduler;
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
    this._cronScheduler = new CronScheduler();
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
    await ensureDirectoryExistsAsync(getCronDir());
    await this._loadAllTasksAsync();

    // Read concurrency settings from config
    const config = ConfigService.getInstance().getConfig();
    this._maxParallelCrons = config.scheduler.maxParallelCrons ?? DEFAULT_MAX_PARALLEL_CRONS;
    this._cronQueueSize = config.scheduler.cronQueueSize ?? DEFAULT_CRON_QUEUE_SIZE;

    this._cronScheduler.start();

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
    this._cronScheduler.stop();

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

    const filePath: string = getCronFilePath(taskId);

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
    const cronDir: string = getCronDir();

    let entries: string[];

    try {
      entries = await fs.readdir(cronDir);
    } catch (error: unknown) {
      this._logger.warn("Failed to read cron directory", {
        cronDir,
        error: extractErrorMessage(error),
      });
      return;
    }

    const jsonFiles: string[] = entries.filter((entry: string) =>
      entry.endsWith(".json"),
    );

    // Migrate all schedule formats (cron, interval, once) to scheduled format
    // before schema validation since old formats won't pass the new schema
    await this._migrateAllSchedulesAsync(cronDir, jsonFiles);

    // Build per-table write tool names once to migrate legacy generic write tools
    // in existing persisted cron tasks.
    let perTableWriteToolNames: string[] = [];
    try {
      const perTableTools = await buildPerTableToolsAsync();
      perTableWriteToolNames = Object.keys(perTableTools)
        .filter((name: string): boolean => name.startsWith("write_table_"))
        .sort();
    } catch (error: unknown) {
      this._logger.warn("Failed to build per-table tools for cron migration", {
        error: extractErrorMessage(error),
      });
    }

    const migratedTasks: string[] = [];

    for (const fileName of jsonFiles) {
      const filePath: string = path.join(cronDir, fileName);

      try {
        const content: string = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        const task: IScheduledTask = scheduledTaskSchema.parse(parsed);

        const migration = this._migrateLegacyWriteTools(task, perTableWriteToolNames);
        if (migration.changed) {
          await fs.writeFile(filePath, JSON.stringify(migration.task, null, 2), "utf-8");

          this._logger.info("Migrated legacy write cron tools to per-table tools", {
            taskId: migration.task.taskId,
            name: migration.task.name,
            replacedTools: migration.replacedTools,
            addedWriteTableTools: migration.addedWriteTableTools,
          });
        }

        const effectiveTask: IScheduledTask = migration.task;

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
        `${migratedTasks.length} cron task(s) use deprecated tool names that will be auto-expanded at runtime:`,
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
      this._logger.warn("Legacy write cron tools detected but no write_table_* tools exist yet", {
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

  private async _migrateAllSchedulesAsync(
    cronDir: string,
    jsonFiles: string[],
  ): Promise<void> {
    await this._migrateCronExpressionSchedulesAsync(cronDir, jsonFiles);
    await this._migrateIntervalSchedulesAsync(cronDir, jsonFiles);
    await this._migrateOnceSchedulesAsync(cronDir, jsonFiles);
  }

  private async _migrateCronExpressionSchedulesAsync(
    cronDir: string,
    jsonFiles: string[],
  ): Promise<void> {
    const cronExpressionRegex = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

    for (const fileName of jsonFiles) {
      const filePath: string = path.join(cronDir, fileName);

      try {
        const content: string = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "schedule" in parsed &&
          typeof (parsed as Record<string, unknown>).schedule === "object" &&
          (parsed as Record<string, unknown>).schedule !== null
        ) {
          const schedule = (parsed as Record<string, unknown>).schedule as Record<string, unknown>;
          if (
            schedule !== null &&
            schedule["type"] === "cron" &&
            typeof schedule["expression"] === "string"
          ) {
            const expression = schedule["expression"] as string;
            const match = expression.match(cronExpressionRegex);

            if (match) {
              const [, minute, hour] = match;
              const scheduleScheduled: IScheduleScheduled = {
                type: "scheduled",
                intervalMinutes: 1440,
                startHour: parseInt(hour, 10),
                startMinute: parseInt(minute, 10),
                runOnce: false,
              };

              const migratedTask: IScheduledTask = {
                ...(parsed as IScheduledTask),
                schedule: scheduleScheduled,
                updatedAt: new Date().toISOString(),
              };

              await fs.writeFile(filePath, JSON.stringify(migratedTask, null, 2), "utf-8");

              this._logger.info("Migrated cron expression to scheduled format", {
                taskId: migratedTask.taskId,
                expression,
                startHour: scheduleScheduled.startHour,
                startMinute: scheduleScheduled.startMinute,
              });
            }
          }
        }
      } catch (error: unknown) {
        this._logger.warn("Failed to migrate cron expression schedule", {
          filePath,
          error: extractErrorMessage(error),
        });
      }
    }
  }

  private async _migrateIntervalSchedulesAsync(
    cronDir: string,
    jsonFiles: string[],
  ): Promise<void> {
    for (const fileName of jsonFiles) {
      const filePath: string = path.join(cronDir, fileName);

      try {
        const content: string = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "schedule" in parsed &&
          typeof (parsed as Record<string, unknown>).schedule === "object" &&
          (parsed as Record<string, unknown>).schedule !== null
        ) {
          const schedule = (parsed as Record<string, unknown>).schedule as Record<string, unknown>;
          if (
            schedule !== null &&
            schedule["type"] === "interval" &&
            typeof schedule["intervalMs"] === "number"
          ) {
            const intervalMs = schedule["intervalMs"] as number;
            const intervalMinutes = Math.round(intervalMs / 60_000);

            if (intervalMinutes > 0) {
              const scheduleScheduled: IScheduleScheduled = {
                type: "scheduled",
                intervalMinutes,
                startHour: null,
                startMinute: null,
                runOnce: false,
              };

              const migratedTask: IScheduledTask = {
                ...(parsed as IScheduledTask),
                schedule: scheduleScheduled,
                updatedAt: new Date().toISOString(),
              };

              await fs.writeFile(filePath, JSON.stringify(migratedTask, null, 2), "utf-8");

              this._logger.info("Migrated interval schedule to scheduled format", {
                taskId: migratedTask.taskId,
                intervalMs,
                intervalMinutes,
              });
            }
          }
        }
      } catch (error: unknown) {
        this._logger.warn("Failed to migrate interval schedule", {
          filePath,
          error: extractErrorMessage(error),
        });
      }
    }
  }

  private async _migrateOnceSchedulesAsync(
    cronDir: string,
    jsonFiles: string[],
  ): Promise<void> {
    for (const fileName of jsonFiles) {
      const filePath: string = path.join(cronDir, fileName);

      try {
        const content: string = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "schedule" in parsed &&
          typeof (parsed as Record<string, unknown>).schedule === "object" &&
          (parsed as Record<string, unknown>).schedule !== null
        ) {
          const schedule = (parsed as Record<string, unknown>).schedule as Record<string, unknown>;
          if (
            schedule !== null &&
            schedule["type"] === "once" &&
            "runAt" in schedule
          ) {
            const runAt = schedule["runAt"] as string;
            const runAtDate = new Date(runAt);
            const runAtHour = runAtDate.getHours();
            const runAtMinute = runAtDate.getMinutes();

            const scheduleScheduled: IScheduleScheduled = {
              type: "scheduled",
              intervalMinutes: 1440,
              startHour: runAtHour,
              startMinute: runAtMinute,
              runOnce: true,
            };

            const migratedTask: IScheduledTask = {
              ...(parsed as IScheduledTask),
              schedule: scheduleScheduled,
              updatedAt: new Date().toISOString(),
            };

            await fs.writeFile(filePath, JSON.stringify(migratedTask, null, 2), "utf-8");

            this._logger.info("Migrated once schedule to scheduled format", {
              taskId: migratedTask.taskId,
              runAt,
              runOnce: true,
            });
          }
        }
      } catch (error: unknown) {
        this._logger.warn("Failed to migrate once schedule", {
          filePath,
          error: extractErrorMessage(error),
        });
      }
    }
  }

  private async _saveTaskAsync(task: IScheduledTask): Promise<void> {
    const filePath: string = getCronFilePath(task.taskId);

    await ensureDirectoryExistsAsync(getCronDir());
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

        if (schedule.runOnce) {
          task.enabled = false;
          task.updatedAt = new Date().toISOString();
          this._tasks.set(task.taskId, task);
          await this._saveTaskAsync(task);
          this._logger.info("One-time task completed and disabled", { taskId: task.taskId });
        }
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
      case "scheduled": {
        const config = ConfigService.getInstance().getConfig();
        const timezone = config.scheduler.timezone;
        const nextRun: Date | null = this._cronScheduler.addScheduledJob(
          task.taskId,
          schedule.intervalMinutes,
          schedule.startHour,
          schedule.startMinute,
          timezone,
          () => {
            this._dispatchOrEnqueue(task, executeCallback);
          },
        );

        this._logger.debug("Scheduled task", {
          taskId: task.taskId,
          intervalMinutes: schedule.intervalMinutes,
          startHour: schedule.startHour,
          startMinute: schedule.startMinute,
          runOnce: schedule.runOnce,
          timezone: timezone ?? "server local",
          nextRun: nextRun ? nextRun.toISOString() : "none",
        });
        break;
      }
    }
  }

  private _unscheduleTask(taskId: string): void {
    this._cronScheduler.removeJob(taskId);

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
