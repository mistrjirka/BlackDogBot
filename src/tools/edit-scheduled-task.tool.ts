import { tool } from "ai";
import { editScheduledTaskToolInputSchema, TOOL_PREREQUISITES, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditScheduledTaskResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "edit_scheduled_task";
const TOOL_DESCRIPTION: string =
  "Modify an existing scheduled task. " +
  "You can patch non-instruction fields (name, description, tools, schedule values, notifyUser, enabled). " +
  "To change instructions, use edit_scheduled_task_instructions with the COMPLETE new instructions text. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "IMPORTANT: You MUST call 'get_scheduled_task' first to retrieve the current task configuration before using this tool.";

//#endregion Const

//#region Tool

const executeEditScheduledTask = async (
  {
    taskId,
    ...patch
  }: {
    taskId: string;
    name?: string;
    description?: string;
    tools?: string[];
    scheduleIntervalMinutes?: number;
    scheduleStartHour?: number | null;
    scheduleStartMinute?: number | null;
    runOnce?: boolean;
    notifyUser?: boolean;
    enabled?: boolean;
  },
  _context: ToolExecuteContext,
): Promise<IEditScheduledTaskResult> => {
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
      return { success: false, error: `Scheduled task with ID '${taskId}' not found.` };
    }

    // 1. Build update payload — reconstruct schedule object from flat params.
    const { scheduleIntervalMinutes, scheduleStartHour, scheduleStartMinute, runOnce, ...restPatch } = patch;
    const updatePayload: Record<string, unknown> = { ...restPatch };

    if (scheduleIntervalMinutes !== undefined || scheduleStartHour !== undefined || scheduleStartMinute !== undefined || runOnce !== undefined) {
      const schedule: Record<string, unknown> = { type: "scheduled" };

      if (scheduleIntervalMinutes !== undefined) {
        schedule.intervalMinutes = scheduleIntervalMinutes;
      } else if ("intervalMinutes" in existingTask.schedule) {
        schedule.intervalMinutes = (existingTask.schedule as any).intervalMinutes;
      }

      if (scheduleStartHour !== undefined) {
        schedule.startHour = scheduleStartHour;
      } else if ("startHour" in existingTask.schedule) {
        schedule.startHour = (existingTask.schedule as any).startHour;
      }

      if (scheduleStartMinute !== undefined) {
        schedule.startMinute = scheduleStartMinute;
      } else if ("startMinute" in existingTask.schedule) {
        schedule.startMinute = (existingTask.schedule as any).startMinute;
      }

      if (runOnce !== undefined) {
        schedule.runOnce = runOnce;
      } else if ("runOnce" in existingTask.schedule) {
        schedule.runOnce = (existingTask.schedule as any).runOnce;
      }

      updatePayload.schedule = schedule;
    }

    if (Object.keys(updatePayload).length === 0) {
      return {
        success: false,
        error:
          "No editable fields were provided. Use edit_scheduled_task for name/description/tools/schedule/notifyUser/enabled. " +
          "To change instructions, use edit_scheduled_task_instructions with the COMPLETE new instructions text and intention.",
      };
    }

    const updatedTask = await scheduler.updateTaskAsync(taskId, updatePayload as any);

    if (updatedTask) {
      logger.info("[edit-scheduled-task] Updated task details", {
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
    logger.error(`[${TOOL_NAME}] Failed to edit scheduled task: ${errorMessage}`, {
      taskId,
      patch,
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

export const editScheduledTaskTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: editScheduledTaskToolInputSchema,
  execute: createToolWithPrerequisites(
    "edit_scheduled_task",
    TOOL_PREREQUISITES["edit_scheduled_task"] || [],
    executeEditScheduledTask,
  ) as any,
});

//#endregion Tool
