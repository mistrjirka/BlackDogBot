import { tool } from "ai";
import { removeJobScheduleToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import type { IJob, INode, IStartNodeConfig } from "../shared/types/index.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

interface IRemoveJobScheduleResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "remove_job_schedule";

const TOOL_DESCRIPTION: string =
  "Remove the schedule from a job. Deletes the linked ScheduledTask and clears the " +
  "start node's scheduledTaskId. The job will no longer run automatically.";

//#endregion Const

//#region Tool

export const removeJobScheduleTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: removeJobScheduleToolInputSchema,
  execute: async ({
    jobId,
  }: {
    jobId: string;
  }): Promise<IRemoveJobScheduleResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const schedulerService: SchedulerService = SchedulerService.getInstance();

      // 1. Find the job
      const job: IJob | null = await storageService.getJobAsync(jobId);

      if (!job) {
        return { success: false, message: `Job "${jobId}" not found.` };
      }

      if (!job.entrypointNodeId) {
        return { success: false, message: `Job "${jobId}" has no entrypoint node.` };
      }

      // 2. Find the start node
      const startNode: INode | null = await storageService.getNodeAsync(jobId, job.entrypointNodeId);

      if (!startNode || startNode.type !== "start") {
        return { success: false, message: `Job "${jobId}" entrypoint is not a start node.` };
      }

      // 3. Check if start node has a scheduledTaskId
      const existingConfig: IStartNodeConfig = startNode.config as IStartNodeConfig;
      const existingTaskId: string | null = existingConfig?.scheduledTaskId ?? null;

      if (!existingTaskId) {
        return { success: false, message: `Job "${job.name}" has no schedule to remove.` };
      }

      // 4. Remove the ScheduledTask
      try {
        await schedulerService.removeTaskAsync(existingTaskId);
      } catch {
        // Task may already be gone — continue with config cleanup
      }

      // 5. Clear the start node config
      const updatedConfig: IStartNodeConfig = { scheduledTaskId: null };
      await storageService.updateNodeAsync(jobId, startNode.nodeId, { config: updatedConfig });

      logger.info(`[${TOOL_NAME}] Schedule removed from job "${job.name}"`, { jobId });

      return {
        success: true,
        message: `Schedule removed from job "${job.name}". ScheduledTask "${existingTaskId}" deleted.`,
      };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      logger.error(`[${TOOL_NAME}] Failed: ${errorMessage}`);

      return { success: false, message: errorMessage };
    }
  },
});

//#endregion Tool
