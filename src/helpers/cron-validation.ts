import { CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import type { Schedule } from "../shared/types/index.js";

export function validateCronToolNames(tools: string[]): string[] {
  const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
  const isDynamicTableTool = (toolName: string): boolean =>
    toolName.startsWith("write_table_") || toolName.startsWith("update_table_");
  return tools.filter((t) => !validToolSet.has(t) && !isDynamicTableTool(t));
}

export function buildSchedule(input: {
  scheduleType: "once" | "interval" | "scheduled";
  scheduleRunAt?: string;
  scheduleIntervalMs?: number;
  scheduleIntervalMinutes?: number;
  scheduleStartHour?: number | null;
  scheduleStartMinute?: number | null;
}): Schedule {
  switch (input.scheduleType) {
    case "once": {
      if (!input.scheduleRunAt || input.scheduleRunAt.trim().length === 0) {
        throw new Error("scheduleRunAt is required for scheduleType='once'");
      }
      return { type: "once", runAt: input.scheduleRunAt };
    }
    case "interval": {
      if (input.scheduleIntervalMs === undefined || !Number.isFinite(input.scheduleIntervalMs) || input.scheduleIntervalMs <= 0) {
        throw new Error("scheduleIntervalMs is required and must be > 0 for scheduleType='interval'");
      }
      return { type: "interval", intervalMs: input.scheduleIntervalMs };
    }
    case "scheduled": {
      if (input.scheduleIntervalMinutes === undefined || !Number.isFinite(input.scheduleIntervalMinutes) || input.scheduleIntervalMinutes <= 0) {
        throw new Error("scheduleIntervalMinutes is required and must be > 0 for scheduleType='scheduled'");
      }
      const startHour: number | null = input.scheduleStartHour ?? null;
      const startMinute: number | null = input.scheduleStartMinute ?? null;

      if (startHour !== null && (startHour < 0 || startHour > 23)) {
        throw new Error("scheduleStartHour must be between 0 and 23 or null");
      }
      if (startMinute !== null && (startMinute < 0 || startMinute > 59)) {
        throw new Error("scheduleStartMinute must be between 0 and 59 or null");
      }

      return {
        type: "scheduled",
        intervalMinutes: input.scheduleIntervalMinutes,
        startHour,
        startMinute,
      };
    }
  }
}

export function patchSchedule(
  existing: Schedule,
  patch: { scheduleRunAt?: string; scheduleIntervalMs?: number; scheduleIntervalMinutes?: number; scheduleStartHour?: number | null; scheduleStartMinute?: number | null },
): Record<string, unknown> {
  const schedule: Record<string, unknown> = { type: existing.type };
  if (existing.type === "once") {
    schedule.runAt = patch.scheduleRunAt !== undefined ? patch.scheduleRunAt : existing.runAt;
  } else if (existing.type === "interval") {
    schedule.intervalMs = patch.scheduleIntervalMs !== undefined ? patch.scheduleIntervalMs : existing.intervalMs;
  } else {
    schedule.intervalMinutes = patch.scheduleIntervalMinutes !== undefined ? patch.scheduleIntervalMinutes : existing.intervalMinutes;
    schedule.startHour = patch.scheduleStartHour !== undefined ? patch.scheduleStartHour : existing.startHour;
    schedule.startMinute = patch.scheduleStartMinute !== undefined ? patch.scheduleStartMinute : existing.startMinute;
  }
  return schedule;
}
