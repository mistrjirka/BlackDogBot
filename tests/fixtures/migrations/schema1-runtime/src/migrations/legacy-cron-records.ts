import { z } from "zod";
import { migrateLegacyTimedTask } from "./legacy-timed-tasks.js";

const completionTimestampSchema = z.string().datetime();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recognize a retained, successfully completed one-time record from cron/.
 * This does not move, rewrite, disable, or import the task.
 *
 * Completion is established from persisted evidence, without using the clock.
 * Unknown or incomplete records must remain blocked for explicit migration.
 */
export function isCompletedLegacyCronRecord(
  raw: unknown,
  options: { fileName: string; defaultTimezone: string },
): boolean {
  if (!isRecord(raw) || !isRecord(raw.schedule) || raw.schedule.type !== "once"
    || typeof raw.taskId !== "string" || raw.taskId.length === 0
    || raw.taskId === "." || raw.taskId === ".." || /[/\\\\\0]/.test(raw.taskId)
    || options.fileName !== `${raw.taskId}.json`
    || raw.lastRunStatus !== "success" || raw.lastRunError !== null) {
    return false;
  }

  const completion = completionTimestampSchema.safeParse(raw.lastRunAt);
  if (!completion.success) return false;

  try {
    // Validate the entire document, including the legacy once/runAt schedule.
    // The converter retains unknown fields and never mutates its input.
    migrateLegacyTimedTask(raw, { defaultTimezone: options.defaultTimezone });
    const completedAt = Date.parse(completion.data);
    const scheduledAt = Date.parse(raw.schedule.runAt as string);
    return Number.isFinite(completedAt) && Number.isFinite(scheduledAt) && completedAt >= scheduledAt;
  } catch {
    return false;
  }
}
