import type { IScheduledTask, IScheduleScheduled } from "../shared/types/index.js";

function formatSchedule(schedule: IScheduleScheduled): string {
  const parts: string[] = [];
  
  if (schedule.startHour !== null && schedule.startMinute !== null) {
    parts.push(`daily at ${schedule.startHour.toString().padStart(2, "0")}:${schedule.startMinute.toString().padStart(2, "0")}`);
  }
  
  if (schedule.intervalMinutes === 60) {
    parts.push("every hour");
  } else if (schedule.intervalMinutes === 1440) {
    parts.push("every day");
  } else {
    parts.push(`every ${schedule.intervalMinutes} minutes`);
  }
  
  if (schedule.runOnce) {
    parts.push("(one-time)");
  }
  
  return parts.join(" ");
}

export function formatScheduledTask(task: IScheduledTask): string {
  const lines: string[] = [];

  lines.push(`Task ID: ${task.taskId}`);
  lines.push(`Name: ${task.name}`);
  lines.push(`Description: ${task.description}`);
  lines.push(`Schedule: ${formatSchedule(task.schedule)}`);
  lines.push(`Tools: [${task.tools.join(", ")}]`);
  lines.push(`Enabled: ${task.enabled}`);
  lines.push(`Notify User: ${task.notifyUser}`);
  lines.push("");
  lines.push("Instructions:");
  lines.push(task.instructions);

  return lines.join("\n");
}
