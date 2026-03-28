import { CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import type { Schedule } from "../shared/types/index.js";

export function validateCronToolNames(tools: string[]): string[] {
  const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
  const isDynamicWriteTableTool = (toolName: string): boolean => toolName.startsWith("write_table_");
  return tools.filter((t) => !validToolSet.has(t) && !isDynamicWriteTableTool(t));
}

export function buildSchedule(input: {
  scheduleType: "once" | "interval" | "cron";
  scheduleRunAt?: string;
  scheduleIntervalMs?: number;
  scheduleCron?: string;
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
    case "cron": {
      if (!input.scheduleCron || input.scheduleCron.trim().length === 0) {
        throw new Error("scheduleCron is required for scheduleType='cron'");
      }
      return { type: "cron", expression: input.scheduleCron };
    }
  }
}

export function patchSchedule(
  existing: Schedule,
  patch: { scheduleRunAt?: string; scheduleIntervalMs?: number; scheduleCron?: string },
): Record<string, unknown> {
  const schedule: Record<string, unknown> = { type: existing.type };
  if (existing.type === "once") {
    schedule.runAt = patch.scheduleRunAt !== undefined ? patch.scheduleRunAt : existing.runAt;
  } else if (existing.type === "interval") {
    schedule.intervalMs = patch.scheduleIntervalMs !== undefined ? patch.scheduleIntervalMs : existing.intervalMs;
  } else {
    schedule.expression = patch.scheduleCron !== undefined ? patch.scheduleCron : existing.expression;
  }
  return schedule;
}
