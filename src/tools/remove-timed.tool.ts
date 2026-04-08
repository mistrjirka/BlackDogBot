import { tool } from "ai";
import { removeTimedToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

interface IRemoveTimedResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "remove_timed";
const TOOL_DESCRIPTION: string = "Remove an existing scheduled task from the scheduler. **Note:** Users may refer to these as 'cron', 'timed', 'scheduled', or 'task'. The system determines intent from context.";

//#endregion Const

//#region Tool

export const removeTimedTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: removeTimedToolInputSchema,
  execute: async ({ taskId }: { taskId: string }): Promise<IRemoveTimedResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      await SchedulerService.getInstance().removeTaskAsync(taskId);

      return { success: true, message: "Task removed successfully" };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      logger.error(`[${TOOL_NAME}] Failed to remove timed task: ${errorMessage}`);

      return { success: false, message: errorMessage };
    }
  },
});

//#endregion Tool
