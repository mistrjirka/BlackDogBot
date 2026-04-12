//#region Cron Types

export interface ICronMessageHistory {
  messageId: string;
  content: string;
  sentAt: string;
}

export interface IScheduleOnce {
  type: "once";
  runAt: string;
  offsetFromDayStart: ITimeParts;
  timezone: string;
}

export interface IScheduleInterval {
  type: "interval";
  every: ITimeParts;
  offsetFromDayStart: ITimeParts;
  timezone: string;
}

export interface ITimeParts {
  hours: number;
  minutes: number;
}

export type Schedule = IScheduleOnce | IScheduleInterval;

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
  messageDedupEnabled: boolean;
}

export interface IExecutionContext {
  toolCallHistory: string[];
  taskName?: string;
  taskDescription?: string;
  taskInstructions?: string;
  messageDedupEnabled?: boolean;
}

//#endregion Cron Types
