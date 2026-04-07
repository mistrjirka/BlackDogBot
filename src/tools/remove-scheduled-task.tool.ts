import { tool } from "ai";
import { removeCronToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

interface IRemoveScheduledTaskResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "remove_scheduled_task";
const TOOL_DESCRIPTION: string = "Remove an existing scheduled task from the scheduler";

//#endregion Const

//#region Tool

export const removeScheduledTaskTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: removeCronToolInputSchema,
  execute: async ({ taskId }: { taskId: string }): Promise<IRemoveScheduledTaskResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      await SchedulerService.getInstance().removeTaskAsync(taskId);

      return { success: true, message: "Task removed successfully" };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      logger.error(`[${TOOL_NAME}] Failed to remove scheduled task: ${errorMessage}`);

      return { success: false, message: errorMessage };
    }
  },
});

//#endregion Tool
