//#region Cron Types

export type ScheduleType = "once" | "interval" | "scheduled";

export interface ICronMessageHistory {
  messageId: string;
  content: string;
  sentAt: string;
}

export interface IScheduleOnce {
  type: "once";
  runAt: string;
}

export interface IScheduleInterval {
  type: "interval";
  intervalMs: number;
}

export interface IScheduleScheduled {
  type: "scheduled";
  intervalMinutes: number;
  startHour: number | null;
  startMinute: number | null;
}

export type Schedule = IScheduleOnce | IScheduleInterval | IScheduleScheduled;

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
  messageHistory: ICronMessageHistory[];
  messageSummary: string | null;
  summaryGeneratedAt: string | null;
}

export interface IExecutionContext {
  toolCallHistory: string[];
  taskName?: string;
  taskDescription?: string;
  taskInstructions?: string;
}

//#endregion Cron Types
