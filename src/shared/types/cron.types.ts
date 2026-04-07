export type ScheduleType = "scheduled";

export interface IScheduleScheduled {
  type: "scheduled";
  intervalMinutes: number;
  startHour: number | null;
  startMinute: number | null;
  runOnce: boolean;
}

export interface IScheduledTask {
  taskId: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  schedule: IScheduleScheduled;
  notifyUser: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: "success" | "failure" | null;
  lastRunError: string | null;
  messageHistory: unknown[];
  messageSummary: string | null;
  summaryGeneratedAt: string | null;
}

export type Schedule = IScheduleScheduled;

export interface IExecutionContext {
  toolCallHistory: string[];
  taskName?: string;
  taskDescription?: string;
  taskInstructions?: string;
}

export interface ICronMessageHistory {
  messageId: string;
  content: string;
  sentAt: string;
}
