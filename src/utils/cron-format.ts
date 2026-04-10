import type { IScheduledTask, Schedule } from "../shared/types/index.js";

function formatSchedule(schedule: Schedule, timezone?: string): string {
  switch (schedule.type) {
    case "interval": {
      const everyStr: string = `every ${schedule.every.hours}h ${schedule.every.minutes}m`;
      const offset = schedule.offsetFromDayStart;
      const hasOffset: boolean = offset.hours > 0 || offset.minutes > 0;
      const offsetStr: string = hasOffset
        ? ` (+${offset.hours}h ${offset.minutes}m from day start)`
        : "";
      const tz: string = schedule.timezone || timezone || "UTC";
      return `${everyStr}${offsetStr} (${tz})`;
    }
    case "once": {
      return `once: ${formatRunAtLocal(schedule.runAt, timezone)}`;
    }
    default:
      return JSON.stringify(schedule);
  }
}

function formatRunAtLocal(runAtIso: string, timezone?: string): string {
  const runAt: Date = new Date(runAtIso);
  const tz: string = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const weekday: string = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(runAt);

  const datePart: string = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(runAt);

  const timePart: string = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(runAt);

  return `${weekday} ${datePart} ${timePart} (${tz})`;
}

export function formatScheduledTask(task: IScheduledTask, timezone?: string): string {
  const lines: string[] = [];

  lines.push(`Task ID: ${task.taskId}`);
  lines.push(`Name: ${task.name}`);
  lines.push(`Description: ${task.description}`);
  lines.push(`Schedule: ${formatSchedule(task.schedule, timezone)}`);
  lines.push(`Tools: [${task.tools.join(", ")}]`);
  lines.push(`Enabled: ${task.enabled}`);
  lines.push(`Notify User: ${task.notifyUser}`);
  lines.push("");
  lines.push("Instructions:");
  lines.push(task.instructions);

  return lines.join("\n");
}
