import type { IScheduledTask, Schedule } from "../shared/types/index.js";

function formatSchedule(schedule: Schedule): string {
  switch (schedule.type) {
    case "interval":
      return `interval: ${schedule.intervalMs}ms`;
    case "once":
      return `once: ${schedule.runAt}`;
    default:
      return JSON.stringify(schedule);
  }
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
