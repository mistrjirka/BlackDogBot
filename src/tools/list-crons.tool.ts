import { tool } from "langchain";
import { listCronsToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IListCronsTaskSummary {
  taskId: string;
  name: string;
  description: string;
  tools: string[];
  schedule: {
    type: string;
    intervalMinutes?: number;
    startHour?: number | null;
    startMinute?: number | null;
    intervalMs?: number;
    runAt?: string;
  };
  enabled: boolean;
  notifyUser: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

interface IListCronsResult {
  tasks: IListCronsTaskSummary[];
}

//#endregion Interfaces

//#region Const

const TOOL_DESCRIPTION: string = "List all scheduled tasks (cron jobs) managed by the scheduler";

//#endregion Const

//#region Private methods

function _mapTaskToSummary(task: IScheduledTask): IListCronsTaskSummary {
  const scheduleSummary: IListCronsTaskSummary["schedule"] = {
    type: task.schedule.type,
  };

  switch (task.schedule.type) {
    case "scheduled":
      scheduleSummary.intervalMinutes = task.schedule.intervalMinutes;
      scheduleSummary.startHour = task.schedule.startHour;
      scheduleSummary.startMinute = task.schedule.startMinute;
      break;
    case "interval":
      scheduleSummary.intervalMs = task.schedule.intervalMs;
      break;
    case "once":
      scheduleSummary.runAt = task.schedule.runAt;
      break;
  }

  return {
    taskId: task.taskId,
    name: task.name,
    description: task.description,
    tools: task.tools,
    schedule: scheduleSummary,
    enabled: task.enabled,
    notifyUser: task.notifyUser,
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
  };
}

//#endregion Private methods

//#region Tool

export const listCronsTool = tool(
  async ({ enabledOnly }: { enabledOnly: boolean }): Promise<IListCronsResult> => {
    const scheduler: SchedulerService = SchedulerService.getInstance();

    const tasks: IScheduledTask[] = enabledOnly
      ? scheduler.getTasksByEnabled(true)
      : scheduler.getAllTasks();

    const mappedTasks: IListCronsTaskSummary[] = tasks.map(_mapTaskToSummary);

    return { tasks: mappedTasks };
  },
  {
    name: "list_crons",
    description: TOOL_DESCRIPTION,
    schema: listCronsToolInputSchema,
  },
);

//#endregion Tool
