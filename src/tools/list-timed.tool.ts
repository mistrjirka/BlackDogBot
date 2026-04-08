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
    intervalMs?: number;
    runAt?: string;
  };
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
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
    case "cron":
      scheduleSummary.expression = task.schedule.expression;
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
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
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
