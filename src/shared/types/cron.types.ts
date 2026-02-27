//#region Cron Types

export type ScheduleType = "once" | "interval" | "cron";

export interface IScheduleOnce {
  type: "once";
  runAt: string;
}

export interface IScheduleInterval {
  type: "interval";
  intervalMs: number;
}

export interface IScheduleCron {
  type: "cron";
  expression: string;
}

export type Schedule = IScheduleOnce | IScheduleInterval | IScheduleCron;

export interface IScheduledTask {
  taskId: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  schedule: Schedule;
  enabled: boolean;
  notifyUser: boolean;
  lastRunAt: string | null;
  lastRunStatus: "success" | "failure" | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
}

//#endregion Cron Types
