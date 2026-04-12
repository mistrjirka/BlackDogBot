import { tool } from "ai";
import { listCronsToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IListTimedTaskSummary {
  taskId: string;
  name: string;
  description: string;
  tools: string[];
  schedule: {
    type: string;
    expression?: string;
    every?: {
      hours?: number;
      minutes?: number;
    };
    runAt?: string;
    offsetFromDayStart?: {
      hours?: number;
      minutes?: number;
    };
    timezone?: string;
  };
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  messageDedupEnabled: boolean;
}

interface IListTimedResult {
  tasks: IListTimedTaskSummary[];
}

//#endregion Interfaces

//#region Const

const TOOL_DESCRIPTION: string = "List all scheduled tasks managed by the scheduler. **Note:** Users may refer to these as 'cron', 'timed', 'scheduled', or 'task'. The system determines intent from context.";

//#endregion Const

//#region Private methods

function _mapTaskToSummary(task: IScheduledTask): IListTimedTaskSummary {
  const scheduleSummary: IListTimedTaskSummary["schedule"] = {
    type: task.schedule.type,
  };

  switch (task.schedule.type) {
    case "interval":
      scheduleSummary.every = task.schedule.every;
      scheduleSummary.offsetFromDayStart = task.schedule.offsetFromDayStart;
      scheduleSummary.timezone = task.schedule.timezone;
      break;
    case "once":
      scheduleSummary.runAt = task.schedule.runAt;
      scheduleSummary.offsetFromDayStart = task.schedule.offsetFromDayStart;
      scheduleSummary.timezone = task.schedule.timezone;
      break;
  }

  return {
    taskId: task.taskId,
    name: task.name,
    description: task.description,
    tools: task.tools,
    schedule: scheduleSummary,
    enabled: task.enabled,
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
    messageDedupEnabled: task.messageDedupEnabled,
  };
}

//#endregion Private methods

//#region Tool

export const listTimedTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: listCronsToolInputSchema,
  execute: async ({ enabledOnly }: { enabledOnly: boolean }): Promise<IListTimedResult> => {
    const scheduler: SchedulerService = SchedulerService.getInstance();

    const tasks: IScheduledTask[] = enabledOnly
      ? scheduler.getTasksByEnabled(true)
      : scheduler.getAllTasks();

    const mappedTasks: IListTimedTaskSummary[] = tasks.map(_mapTaskToSummary);

    return { tasks: mappedTasks };
  },
});

//#endregion Tool
