import { tool } from "ai";
import { setJobScheduleToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { generateId } from "../utils/id.js";
import type { IJob, INode, IStartNodeConfig } from "../shared/types/index.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

interface ISetJobScheduleResult {
  success: boolean;
  scheduledTaskId: string;
  message: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "set_job_schedule";

const TOOL_DESCRIPTION: string =
  "Set or update a schedule on a job. Creates a ScheduledTask that will automatically " +
  "run the job on the given schedule. If the job already has a schedule, the old one is " +
  "replaced. The schedule uses the same format as add_cron (type: 'once'/'interval'/'cron').";

//#endregion Const

//#region Private methods

function _buildSchedule(input: {
  type: "once" | "interval" | "cron";
  runAt?: string;
  intervalMs?: number;
  expression?: string;
}): Schedule {
  switch (input.type) {
    case "once":
      return { type: "once", runAt: input.runAt! };
    case "interval":
      return { type: "interval", intervalMs: input.intervalMs! };
    case "cron":
      return { type: "cron", expression: input.expression! };
  }
}

//#endregion Private methods

//#region Tool

export const setJobScheduleTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: setJobScheduleToolInputSchema,
  execute: async ({
    jobId,
    schedule,
  }: {
    jobId: string;
    schedule: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string };
  }): Promise<ISetJobScheduleResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const schedulerService: SchedulerService = SchedulerService.getInstance();

      // 1. Find the job
      const job: IJob | null = await storageService.getJobAsync(jobId);

      if (!job) {
        return { success: false, scheduledTaskId: "", message: `Job "${jobId}" not found.` };
      }

      if (!job.entrypointNodeId) {
        return { success: false, scheduledTaskId: "", message: `Job "${jobId}" has no entrypoint node.` };
      }

      // 2. Find the start node
      const startNode: INode | null = await storageService.getNodeAsync(jobId, job.entrypointNodeId);

      if (!startNode || startNode.type !== "start") {
        return { success: false, scheduledTaskId: "", message: `Job "${jobId}" entrypoint is not a start node.` };
      }

      // 3. If start node already has a scheduledTaskId, remove the old ScheduledTask
      const existingConfig: IStartNodeConfig = startNode.config as IStartNodeConfig;
      const existingTaskId: string | null = existingConfig?.scheduledTaskId ?? null;

      if (existingTaskId) {
        try {
          await schedulerService.removeTaskAsync(existingTaskId);
        } catch {
          // Old task may already be gone — continue
        }
      }

      // 4. Create a new ScheduledTask
      const taskId: string = generateId();
      const now: string = new Date().toISOString();
      const builtSchedule: Schedule = _buildSchedule(schedule);

      const task: IScheduledTask = {
        taskId,
        name: `Job: ${job.name}`,
        description: `Auto-scheduled task for job "${job.name}" (${jobId})`,
        instructions: `Run job ${jobId} titled '${job.name}'. Use the run_job tool with jobId="${jobId}".`,
        tools: ["run_job"],
        schedule: builtSchedule,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
      };

      await schedulerService.addTaskAsync(task);

      // 5. Update start node config with scheduledTaskId
      const updatedConfig: IStartNodeConfig = { scheduledTaskId: taskId };
      await storageService.updateNodeAsync(jobId, startNode.nodeId, { config: updatedConfig });

      logger.info(`[${TOOL_NAME}] Schedule set for job "${job.name}"`, { jobId, taskId });

      return {
        success: true,
        scheduledTaskId: taskId,
        message: `Schedule set for job "${job.name}". ScheduledTask "${taskId}" created with ${schedule.type} schedule.`,
      };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      logger.error(`[${TOOL_NAME}] Failed: ${errorMessage}`);

      return { success: false, scheduledTaskId: "", message: errorMessage };
    }
  },
});

//#endregion Tool
