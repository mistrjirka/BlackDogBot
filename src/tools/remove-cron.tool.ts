import { tool } from "langchain";
import { removeCronToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

interface IRemoveCronResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "remove-cron";
const TOOL_DESCRIPTION: string = "Remove an existing scheduled task (cron job) from the scheduler";

//#endregion Const

//#region Tool

export const removeCronTool = tool(
  async ({ taskId }: { taskId: string }): Promise<IRemoveCronResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      await SchedulerService.getInstance().removeTaskAsync(taskId);

      return { success: true, message: "Task removed successfully" };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      logger.error(`[${TOOL_NAME}] Failed to remove cron task: ${errorMessage}`);

      return { success: false, message: errorMessage };
    }
  },
  {
    name: "remove_cron",
    description: TOOL_DESCRIPTION,
    schema: removeCronToolInputSchema,
  },
);

//#endregion Tool
