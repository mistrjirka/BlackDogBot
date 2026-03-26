import { tool } from "langchain";
import { editCronToolInputSchema, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditCronResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "edit_cron";
const TOOL_DESCRIPTION: string =
  "Modify an existing scheduled task (cron job). " +
  "You can patch non-instruction fields (name, description, tools, schedule values, notifyUser, enabled). " +
  "To change instructions, use edit_cron_instructions with the COMPLETE new instructions text. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "IMPORTANT: You MUST call 'get_cron' first to retrieve the current task configuration before using this tool.";

//#endregion Const

//#region Tool

const executeEditCron = async ({
    taskId,
    ...patch
  }: {
    taskId: string;
    name?: string;
    description?: string;
    tools?: string[];
    scheduleType?: "once" | "interval" | "cron";
    scheduleRunAt?: string;
    scheduleIntervalMs?: number;
    scheduleCron?: string;
    notifyUser?: boolean;
    enabled?: boolean;
  }): Promise<IEditCronResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();

  try {
    // 0. Validate tool names at runtime (if provided)
    if (patch.tools !== undefined) {
      const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
      const isDynamicWriteTableTool = (toolName: string): boolean => toolName.startsWith("write_table_");
      const invalidTools: string[] = patch.tools.filter(
        (t) => !validToolSet.has(t) && !isDynamicWriteTableTool(t),
      );
      if (invalidTools.length > 0) {
        return {
          success: false,
          error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}`,
        };
      }
    }

    const existingTask = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Cron task with ID '${taskId}' not found.` };
    }
    // 1. Build update payload — reconstruct schedule object from flat params.
    const { scheduleType, scheduleRunAt, scheduleIntervalMs, scheduleCron, ...restPatch } = patch;
    const updatePayload: Record<string, unknown> = { ...restPatch };

    if (scheduleType !== undefined) {
      // Schedule type is immutable. Ignore requested type changes and preserve existing type.
      if (scheduleType !== existingTask.schedule.type) {
        logger.debug(`[${TOOL_NAME}] Ignoring scheduleType change request`, {
          taskId,
          requestedType: scheduleType,
          existingType: existingTask.schedule.type,
        });
      }

      const schedule: Record<string, unknown> = { type: existingTask.schedule.type };

      if (existingTask.schedule.type === "once") {
        schedule.runAt = scheduleRunAt !== undefined ? scheduleRunAt : existingTask.schedule.runAt;
      } else if (existingTask.schedule.type === "interval") {
        schedule.intervalMs = scheduleIntervalMs !== undefined ? scheduleIntervalMs : existingTask.schedule.intervalMs;
      } else {
        schedule.expression = scheduleCron !== undefined ? scheduleCron : existingTask.schedule.expression;
      }

      updatePayload.schedule = schedule;
    } else if (scheduleRunAt !== undefined || scheduleIntervalMs !== undefined || scheduleCron !== undefined) {
      // Allow schedule value-only edits without requiring scheduleType.
      const schedule: Record<string, unknown> = { type: existingTask.schedule.type };

      if (existingTask.schedule.type === "once") {
        schedule.runAt = scheduleRunAt !== undefined ? scheduleRunAt : existingTask.schedule.runAt;
      } else if (existingTask.schedule.type === "interval") {
        schedule.intervalMs = scheduleIntervalMs !== undefined ? scheduleIntervalMs : existingTask.schedule.intervalMs;
      } else {
        schedule.expression = scheduleCron !== undefined ? scheduleCron : existingTask.schedule.expression;
      }

      updatePayload.schedule = schedule;
    }

    if (Object.keys(updatePayload).length === 0) {
      return {
        success: false,
        error:
          "No editable fields were provided. Use edit_cron for name/description/tools/schedule/notifyUser/enabled. " +
          "To change instructions, use edit_cron_instructions with the COMPLETE new instructions text and intention.",
      };
    }

    const updatedTask = await scheduler.updateTaskAsync(taskId, updatePayload as Partial<IScheduledTask>);

    if (updatedTask) {
      logger.info("[edit-cron] Updated task details", {
        taskId: updatedTask.taskId,
        name: updatedTask.name,
        description: updatedTask.description,
        schedule: updatedTask.schedule,
        tools: updatedTask.tools,
        notifyUser: updatedTask.notifyUser,
        enabled: updatedTask.enabled,
        instructions: updatedTask.instructions,
        messageHistoryCount: updatedTask.messageHistory.length,
        updatedAt: updatedTask.updatedAt,
      });
    }

    return {
      success: true,
      task: updatedTask,
      display: updatedTask ? formatScheduledTask(updatedTask) : undefined,
    };
  } catch (error: unknown) {
    const errorMessage: string = extractErrorMessage(error);
    logger.error(`[${TOOL_NAME}] Failed to edit cron task: ${errorMessage}`, {
      taskId,
      patch,
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

export const editCronTool = tool(
  executeEditCron,
  {
    name: "edit_cron",
    description: TOOL_DESCRIPTION,
    schema: editCronToolInputSchema,
  },
);

//#endregion Tool
