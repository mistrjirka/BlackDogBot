import { tool } from "ai";
import {
  getCronToolInputSchema,
} from "../shared/schemas/index.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { IScheduledTask } from "../shared/types/index.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { ToolExecuteContext } from "../utils/tool-factory.js";

//#region Interfaces

interface IGetCronResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Tool

export const getScheduledTaskTool = tool({
  description: "Get the full configuration of a scheduled task by its ID.",
  inputSchema: getCronToolInputSchema,
  execute: async (
    { taskId }: { taskId: string },
    _context: ToolExecuteContext,
  ): Promise<IGetCronResult> => {
    const scheduler: SchedulerService = SchedulerService.getInstance();
    const task: IScheduledTask | undefined =
      await scheduler.getTaskAsync(taskId);

    if (!task) {
      return {
        success: false,
        error: `Scheduled task with ID '${taskId}' not found.`,
      };
    }

    return {
      success: true,
      task,
      display: formatScheduledTask(task),
    };
  },
} as any);

//#endregion Tool
