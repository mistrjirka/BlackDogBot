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

export const scheduleCronSchema = z.object({
  type: z.literal("cron"),
  expression: z.string()
    .min(1)
    .describe("Cron expression (e.g. '0 9 * * *' for daily at 09:00)"),
});

export const scheduleSchema = z.discriminatedUnion("type", [
  scheduleOnceSchema,
  scheduleIntervalSchema,
  scheduleCronSchema,
]);

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
});

//#endregion Cron Schemas
