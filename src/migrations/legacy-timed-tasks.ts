import { scheduledTaskSchema } from "../shared/schemas/cron.schemas.js";

export interface TimedTaskMigrationOptions {
  defaultTimezone: string;
}

export interface TimedTaskMigrationResult {
  task: Record<string, unknown>;
  migrated: boolean;
  changes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function fail(message: string): never {
  throw new Error(`Cannot migrate timed task: ${message}`);
}

function minuteParts(value: unknown, field: string, maximum: number, minimum = 0): { hours: number; minutes: number } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${field} must be an integer between ${minimum} and ${maximum}. Review this task's schedule before upgrading.`);
  }
  return { hours: Math.floor(value / 60), minutes: value % 60 };
}

function legacyEvery(value: unknown): { hours: number; minutes: number } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value % 60_000 !== 0) {
    fail("schedule.intervalMs must be a whole number of minutes. Sub-minute intervals cannot be converted without changing timing.");
  }
  return minuteParts(value / 60_000, "schedule.intervalMs / 60000", 1440, 1);
}

function sameTimeParts(value: unknown, expected: { hours: number; minutes: number }): boolean {
  return isRecord(value) && value.hours === expected.hours && value.minutes === expected.minutes;
}

function validateTimezone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("schedule.timezone must be a valid timezone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    fail("schedule.timezone is not supported by this runtime.");
  }
  return value;
}

/**
 * Convert known persisted task shapes without reading or writing files.
 *
 * The caller owns backup, validation of the complete plan, and atomic persistence.
 * This deliberately has no clock dependency: a once task keeps its exact runAt,
 * and task IDs, timestamps, history, and unrecognized fields are retained.
 *
 * Legacy interval tasks adopt the day-start grid introduced by 49ac572. Their
 * former startup-relative phase cannot be recovered from the persisted file.
 */
export function migrateLegacyTimedTask(
  raw: unknown,
  options: TimedTaskMigrationOptions,
): TimedTaskMigrationResult {
  if (!isRecord(raw) || !isRecord(raw.schedule)) {
    fail("expected an object with a schedule.");
  }

  const schedule: Record<string, unknown> = { ...raw.schedule };
  const task: Record<string, unknown> = { ...raw, schedule };
  const changes: string[] = [];

  if (schedule.type !== "interval" && schedule.type !== "once") {
    fail("unsupported schedule type. Convert this task explicitly before upgrading.");
  }

  if (schedule.type === "interval") {
    const every = hasOwn(schedule, "intervalMs") ? legacyEvery(schedule.intervalMs) : undefined;
    if (hasOwn(schedule, "every")) {
      if (every && !sameTimeParts(schedule.every, every)) {
        fail("schedule.every conflicts with schedule.intervalMs.");
      }
    } else {
      if (!every) {
        fail("interval schedule has neither every nor intervalMs.");
      }
      schedule.every = every;
      changes.push("schedule.intervalMs -> schedule.every (day-start grid)");
    }

    const offset = hasOwn(schedule, "offsetMinutes")
      ? minuteParts(schedule.offsetMinutes, "schedule.offsetMinutes", 1439)
      : { hours: 0, minutes: 0 };
    if (hasOwn(schedule, "offsetFromDayStart")) {
      if (hasOwn(schedule, "offsetMinutes") && !sameTimeParts(schedule.offsetFromDayStart, offset)) {
        fail("schedule.offsetFromDayStart conflicts with schedule.offsetMinutes.");
      }
    } else {
      schedule.offsetFromDayStart = offset;
      changes.push("schedule.offsetFromDayStart");
    }

    if (hasOwn(schedule, "intervalMs")) {
      delete schedule.intervalMs;
      changes.push("remove schedule.intervalMs");
    }
    if (hasOwn(schedule, "offsetMinutes")) {
      delete schedule.offsetMinutes;
      changes.push("remove schedule.offsetMinutes");
    }
  } else {
    if (!hasOwn(schedule, "runAt")) {
      fail("one-time schedule has no runAt. Its original time cannot be reconstructed.");
    }
    if (hasOwn(schedule, "intervalMs")) {
      fail("one-time schedule contains intervalMs. Its intended time is ambiguous.");
    }
    if (hasOwn(schedule, "offsetMinutes")) {
      // The legacy once executor used runAt directly, without applying this field.
      minuteParts(schedule.offsetMinutes, "schedule.offsetMinutes", Number.MAX_SAFE_INTEGER);
      delete schedule.offsetMinutes;
      changes.push("remove unused schedule.offsetMinutes");
    }
    if (!hasOwn(schedule, "offsetFromDayStart")) {
      schedule.offsetFromDayStart = { hours: 0, minutes: 0 };
      changes.push("schedule.offsetFromDayStart");
    }
  }

  if (!hasOwn(schedule, "timezone")) {
    schedule.timezone = validateTimezone(options.defaultTimezone);
    changes.push("schedule.timezone");
  } else {
    validateTimezone(schedule.timezone);
  }

  const validation = scheduledTaskSchema.safeParse(task);
  if (!validation.success) {
    // Zod enum messages include received values, which may be private task data.
    const fields = [...new Set(validation.error.issues.map(issue => issue.path.join(".")))].join(", ");
    fail(`invalid fields: ${fields}. Correct these fields before upgrading.`);
  }

  // Use parsed defaults only where absent. Returning Zod's parsed object would
  // silently remove user extensions at the top level and within the schedule.
  for (const [key, value] of Object.entries(validation.data)) {
    if (!hasOwn(task, key)) {
      task[key] = value;
      changes.push(key);
    }
  }

  return { task, migrated: changes.length > 0, changes };
}
