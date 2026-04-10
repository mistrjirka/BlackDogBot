import { z } from "zod";

//#region Cron Schemas

const everyTimePartsSchema = z.object({
  hours: z.number()
    .int()
    .nonnegative()
    .max(24)
    .default(0),
  minutes: z.number()
    .int()
    .min(0)
    .max(59)
    .default(0),
}).superRefine((data, ctx) => {
  if (data.hours === 24 && data.minutes !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minutes"],
      message: "minutes must be 0 when hours is 24",
    });
  }
});

const offsetTimePartsSchema = z.object({
  hours: z.number()
    .int()
    .min(0)
    .max(23)
    .default(0),
  minutes: z.number()
    .int()
    .min(0)
    .max(59)
    .default(0),
});

export const scheduleOnceSchema = z.object({
  type: z.literal("once"),
  runAt: z.string()
    .datetime()
    .describe("ISO 8601 datetime to run at"),
  offsetFromDayStart: offsetTimePartsSchema
    .default({ hours: 0, minutes: 0 })
    .describe("Offset from day start (midnight) in local timezone"),
  timezone: z.string()
    .min(1)
    .default("UTC")
    .describe("IANA timezone for schedule calculations"),
});

const scheduleIntervalBaseSchema = z.object({
  type: z.literal("interval"),
  every: everyTimePartsSchema
    .describe("Interval in hours/minutes"),
  offsetFromDayStart: offsetTimePartsSchema
    .default({ hours: 0, minutes: 0 })
    .describe("Offset from day start (midnight) in local timezone"),
  timezone: z.string()
    .min(1)
    .default("UTC")
    .describe("IANA timezone for schedule calculations"),
});

export const scheduleIntervalSchema = scheduleIntervalBaseSchema.superRefine((data, ctx) => {
  if (data.every.hours === 0 && data.every.minutes === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["every"],
      message: "every must be > 0 (set hours or minutes)",
    });
  }
});

export const scheduleSchema = z.discriminatedUnion("type", [
  scheduleOnceSchema,
  scheduleIntervalBaseSchema,
]).superRefine((data, ctx) => {
  if (data.type === "interval" && data.every.hours === 0 && data.every.minutes === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["every"],
      message: "every must be > 0 (set hours or minutes)",
    });
  }
});

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
