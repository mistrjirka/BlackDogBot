import fs from "node:fs/promises";
import path from "node:path";

import { CronScheduler } from "./cron-scheduler.js";

import { IScheduledTask } from "../shared/types/index.js";
import { scheduledTaskSchema } from "../shared/schemas/index.js";
import {
  getCronDir,
  getCronFilePath,
  ensureDirectoryExistsAsync,
} from "../utils/paths.js";
import { LoggerService } from "./logger.service.js";
import { ConfigService } from "./config.service.js";
import { extractErrorMessage } from "../utils/error.js";

export class SchedulerService {
  //#region Data members

  private static _instance: SchedulerService | null;
  private _logger: LoggerService;
  private _cronScheduler: CronScheduler;
  private _tasks: Map<string, IScheduledTask>;
  private _taskExecutor: ((task: IScheduledTask) => Promise<void>) | null;
  private _onTaskFailure: ((task: IScheduledTask, error: string) => Promise<void>) | null;
  private _intervals: Map<string, NodeJS.Timeout>;
  private _timeouts: Map<string, NodeJS.Timeout>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._cronScheduler = new CronScheduler();
    this._tasks = new Map();
    this._taskExecutor = null;
    this._onTaskFailure = null;
    this._intervals = new Map();
    this._timeouts = new Map();
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

  public async startAsync(): Promise<void> {
    await ensureDirectoryExistsAsync(getCronDir());
    await this._loadAllTasksAsync();

    this._cronScheduler.start();

    for (const task of this._tasks.values()) {
      if (task.enabled) {
        this._scheduleTask(task);
      }
    }

    this._logger.info("Scheduler started", {
      totalTasks: this._tasks.size,
      enabledTasks: this.getTasksByEnabled(true).length,
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

    this._logger.info("Scheduler stopped");
  }

  public async addTaskAsync(task: IScheduledTask): Promise<void> {
    await this._saveTaskAsync(task);
    this._tasks.set(task.taskId, task);

    if (task.enabled) {
      this._scheduleTask(task);
    }

    this._logger.info("Task added", { taskId: task.taskId, name: task.name });
  }

  public async removeTaskAsync(taskId: string): Promise<void> {
    this._unscheduleTask(taskId);
    this._tasks.delete(taskId);

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

    this._tasks.set(taskId, task);
    await this._saveTaskAsync(task);

    if (enabledChanged || scheduleChanged) {
      this._unscheduleTask(taskId);
      if (task.enabled) {
        this._scheduleTask(task);
      }
    }

    this._logger.info("Task updated", { taskId, name: task.name });
    return task;
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

    for (const fileName of jsonFiles) {
      const filePath: string = path.join(cronDir, fileName);

      try {
        const content: string = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        const task: IScheduledTask = scheduledTaskSchema.parse(parsed);

        this._tasks.set(task.taskId, task);
      } catch (error: unknown) {
        this._logger.warn("Failed to parse task file, skipping", {
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
      case "cron": {
        const config = ConfigService.getInstance().getConfig();
        const timezone = config.scheduler.timezone;
        const nextRun: Date | null = this._cronScheduler.addJob(
          task.taskId,
          schedule.expression,
          timezone,
          () => {
            void executeCallback();
          },
        );

        this._logger.debug("Scheduled cron task", {
          taskId: task.taskId,
          expression: schedule.expression,
          timezone: timezone ?? "server local",
          nextRun: nextRun ? nextRun.toISOString() : "none",
        });
        break;
      }

      case "interval": {
        const intervalId: NodeJS.Timeout = setInterval(() => {
          void executeCallback();
        }, schedule.intervalMs);

        this._intervals.set(task.taskId, intervalId);
        this._logger.debug("Scheduled interval task", {
          taskId: task.taskId,
          intervalMs: schedule.intervalMs,
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
          void executeCallback();
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
