import { z } from "zod";
import type { IScheduleScheduled } from "../types/cron.types.js";

export const scheduleScheduledSchema: z.ZodType<IScheduleScheduled> = z.object({
  type: z.literal("scheduled"),
  intervalMinutes: z.number().positive(),
  startHour: z.number().min(0).max(23).nullable(),
  startMinute: z.number().min(0).max(59).nullable(),
  runOnce: z.boolean(),
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
  schedule: scheduleScheduledSchema,
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
  messageHistory: z.array(z.unknown())
    .default([]),
  messageSummary: z.string()
    .nullable()
    .default(null),
  summaryGeneratedAt: z.string()
    .datetime()
    .nullable()
    .default(null),
});
