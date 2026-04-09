import { tool } from "ai";
import {
  getCronToolInputSchema,
} from "../shared/schemas/index.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { ConfigService } from "../services/config.service.js";
import { IScheduledTask } from "../shared/types/index.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { ToolExecuteContext } from "../utils/tool-factory.js";

//#region Interfaces

interface IGetTimedResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Tool

export const getTimedTool = tool({
  description: "Get the full configuration of a scheduled task by its ID. **Note:** Users may refer to these as 'cron', 'timed', 'scheduled', or 'task'. The system determines intent from context.",
  inputSchema: getCronToolInputSchema,
  execute: async (
    { taskId }: { taskId: string },
    _context: ToolExecuteContext,
  ): Promise<IGetTimedResult> => {
    const scheduler: SchedulerService = SchedulerService.getInstance();
    const timezone: string | undefined = ConfigService.getInstance().getConfig().scheduler.timezone;
    const task: IScheduledTask | undefined =
      await scheduler.getTaskAsync(taskId);

    if (!task) {
      return {
        success: false,
        error: `Task with ID '${taskId}' not found.`,
      };
    }

    return {
      success: true,
      task,
      display: formatScheduledTask(task, timezone),
    };
  },
} as any);

//#endregion Tool
