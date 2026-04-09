import { tool } from "ai";
import { editIntervalToolInputSchema, TOOL_PREREQUISITES, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { filterInvalidTools } from "../utils/cron-tool-validation.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditIntervalResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "edit_interval";
const TOOL_DESCRIPTION: string =
  "Modify an existing interval-based scheduled task. " +
  "You can patch non-instruction fields (name, description, tools, intervalMs, notifyUser, enabled). " +
  "send_message performs internal deduplication against previous cron messages. " +
  "IMPORTANT: You MUST call 'get_timed' first to retrieve the current task configuration before using this tool.";

//#endregion Const

//#region Tool

const executeEditInterval = async (
  {
    taskId,
    name,
    description,
    tools,
    intervalMs,
    offsetMinutes,
    notifyUser,
    enabled,
  }: {
    taskId: string;
    name?: string;
    description?: string;
    tools?: string[];
    intervalMs?: number;
    offsetMinutes?: number;
    notifyUser?: boolean;
    enabled?: boolean;
  },
  _context: ToolExecuteContext,
): Promise<IEditIntervalResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();
  const timezone: string | undefined = ConfigService.getInstance().getConfig().scheduler.timezone;

  try {
    if (tools !== undefined) {
      const invalidTools: string[] = filterInvalidTools(tools);
      if (invalidTools.length > 0) {
        return {
          success: false,
          error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}`,
        };
      }
    }

    const existingTask = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Task with ID '${taskId}' not found.` };
    }

    if (existingTask.schedule.type !== "interval") {
      return {
        success: false,
        error: `Task '${taskId}' is not an 'interval' schedule type. Use edit_once for one-time tasks.`,
      };
    }

    const patch: Partial<IScheduledTask> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (tools !== undefined) patch.tools = tools;
    if (notifyUser !== undefined) patch.notifyUser = notifyUser;
    if (enabled !== undefined) patch.enabled = enabled;

    if (intervalMs !== undefined || offsetMinutes !== undefined) {
      const currentSchedule = existingTask.schedule;
      patch.schedule = {
        type: "interval",
        intervalMs: intervalMs ?? currentSchedule.intervalMs,
        offsetMinutes: offsetMinutes ?? (currentSchedule.type === "interval" ? currentSchedule.offsetMinutes : 0),
      };
    }

    if (Object.keys(patch).length === 0) {
      return {
        success: false,
        error: "No editable fields were provided.",
      };
    }

    const updatedTask = await scheduler.updateTaskAsync(taskId, patch);

    if (updatedTask) {
      logger.info("[edit_interval] Updated task details", {
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
      display: updatedTask ? formatScheduledTask(updatedTask, timezone) : undefined,
    };
  } catch (error: unknown) {
    const errorMessage: string = extractErrorMessage(error);
    logger.error(`[${TOOL_NAME}] Failed to edit task: ${errorMessage}`, {
      taskId,
      patch: { name, description, tools, intervalMs, offsetMinutes, notifyUser, enabled },
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

export const editIntervalTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: editIntervalToolInputSchema,
  execute: createToolWithPrerequisites(
    "edit_interval",
    TOOL_PREREQUISITES["edit_interval"] || [],
    executeEditInterval,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK tool execute typing mismatch with wrapper
  ) as any,
});

//#endregion Tool
