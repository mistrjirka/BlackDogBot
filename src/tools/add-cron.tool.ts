import { tool } from "ai";
import { addCronToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { generateId } from "../utils/id.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

interface IAddCronResult {
  taskId: string;
  success: boolean;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "add-cron";
const TOOL_DESCRIPTION: string = "Add a new scheduled task (cron job) to the scheduler";

//#endregion Const

//#region Private methods

function _buildSchedule(input: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string }): Schedule {
  switch (input.type) {
    case "once":
      return {
        type: "once",
        runAt: input.runAt!,
      };
    case "interval":
      return {
        type: "interval",
        intervalMs: input.intervalMs!,
      };
    case "cron":
      return {
        type: "cron",
        expression: input.expression!,
      };
  }
}

//#endregion Private methods

//#region Tool

export const addCronTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: addCronToolInputSchema,
  execute: async ({
    name,
    description,
    instructions,
    tools,
    schedule,
  }: {
    name: string;
    description: string;
    instructions: string;
    tools: string[];
    schedule: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string };
  }): Promise<IAddCronResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const taskId: string = generateId();
      const now: string = new Date().toISOString();
      const builtSchedule: Schedule = _buildSchedule(schedule);

      const task: IScheduledTask = {
        taskId,
        name,
        description,
        instructions,
        tools,
        schedule: builtSchedule,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
      };

      await SchedulerService.getInstance().addTaskAsync(task);

      return { taskId, success: true };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      logger.error(`[${TOOL_NAME}] Failed to add cron task: ${errorMessage}`);

      return { taskId: "", success: false, error: errorMessage };
    }
  },
});

//#endregion Tool
