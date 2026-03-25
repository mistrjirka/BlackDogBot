import { tool } from "langchain";
import {
  getCronToolInputSchema,
} from "../shared/schemas/index.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { IScheduledTask } from "../shared/types/index.js";
import { formatScheduledTask } from "../utils/cron-format.js";

//#region Interfaces

interface IGetCronResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Tool

export const getCronTool = tool(
  async ({ taskId }: { taskId: string }): Promise<IGetCronResult> => {
    const scheduler: SchedulerService = SchedulerService.getInstance();
    const task: IScheduledTask | undefined =
      await scheduler.getTaskAsync(taskId);

    if (!task) {
      return {
        success: false,
        error: `Cron task with ID '${taskId}' not found.`,
      };
    }

    return {
      success: true,
      task,
      display: formatScheduledTask(task),
    };
  },
  {
    name: "get_cron",
    description: "Get the full configuration of a scheduled (cron) task by its ID.",
    schema: getCronToolInputSchema,
  },
);

//#endregion Tool
