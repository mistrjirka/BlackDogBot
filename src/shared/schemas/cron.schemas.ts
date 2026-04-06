import { z } from "zod";

//#region Cron Schemas

export const scheduleOnceSchema = z.object({
  type: z.literal("once"),
  runAt: z.string()
    .datetime()
    .describe("ISO 8601 datetime to run at"),
});

export const scheduleIntervalSchema = z.object({
  type: z.literal("interval"),
  intervalMs: z.number()
    .int()
    .positive()
    .describe("Interval in milliseconds"),
});

export const scheduleScheduledSchema = z.object({
  type: z.literal("scheduled"),
  intervalMinutes: z.number()
    .int()
    .positive()
    .describe("Interval in minutes (e.g. 60 for hourly, 120 for every 2 hours, 1440 for daily)"),
  startHour: z.number()
    .int()
    .min(0)
    .max(23)
    .nullable()
    .describe("Hour of day (0-23) when the interval starts. Null means start from current time."),
  startMinute: z.number()
    .int()
    .min(0)
    .max(59)
    .nullable()
    .describe("Minute of hour (0-59) when the interval starts. Null means start from current time."),
});

export const scheduleSchema = z.discriminatedUnion("type", [
  scheduleOnceSchema,
  scheduleIntervalSchema,
  scheduleScheduledSchema,
]);

export const cronMessageHistorySchema = z.object({
  messageId: z.string()
    .min(1),
  content: z.string()
    .min(1),
  sentAt: z.string()
    .datetime(),
});

export const scheduledTaskSchema = z.object({
  taskId: z.string()
    .min(1),
  name: z.string()
    .min(1)
    .describe("Task name"),
  description: z.string()
    .default("")
    .describe("Task description"),
  instructions: z.string()
    .min(1)
    .describe("Detailed instructions for the task agent"),
  tools: z.string()
    .array()
    .min(1)
    .describe("Tool names available to the task agent"),
  schedule: scheduleSchema,
  notifyUser: z.boolean()
    .describe("Whether to send a Telegram notification when this task completes"),
  enabled: z.boolean()
    .default(true),
  lastRunAt: z.string()
    .nullable()
    .default(null),
  lastRunStatus: z.enum(["success", "failure"])
    .nullable()
    .default(null),
  lastRunError: z.string()
    .nullable()
    .default(null),
  createdAt: z.string()
    .datetime(),
  updatedAt: z.string()
    .datetime(),
  messageHistory: cronMessageHistorySchema.array()
    .default([]),
  messageSummary: z.string()
    .nullable()
    .default(null),
  summaryGeneratedAt: z.string()
    .datetime()
    .nullable()
    .default(null),
});

//#endregion Cron Schemas
