import { tool } from "ai";
import { editOnceToolInputSchema, TOOL_PREREQUISITES, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditOnceResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "edit_once";
const TOOL_DESCRIPTION: string =
  "Modify an existing one-time scheduled task. " +
  "You can patch non-instruction fields (name, description, tools, runAt, notifyUser, enabled). " +
  "send_message performs internal deduplication against previous cron messages. " +
  "IMPORTANT: You MUST call 'get_timed' first to retrieve the current task configuration before using this tool.";

//#endregion Const

//#region Tool

const executeEditOnce = async (
  {
    taskId,
    name,
    description,
    tools,
    runAt,
    notifyUser,
    enabled,
  }: {
    taskId: string;
    name?: string;
    description?: string;
    tools?: string[];
    runAt?: string;
    notifyUser?: boolean;
    enabled?: boolean;
  },
  _context: ToolExecuteContext,
): Promise<IEditOnceResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();

  try {
    if (tools !== undefined) {
      const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
      const isDynamicWriteTableTool = (toolName: string): boolean => toolName.startsWith("write_table_");
      const invalidTools: string[] = tools.filter(
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
      return { success: false, error: `Task with ID '${taskId}' not found.` };
    }

    if (existingTask.schedule.type !== "once") {
      return {
        success: false,
        error: `Task '${taskId}' is not a 'once' schedule type. Use edit_interval for interval tasks.`,
      };
    }

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (tools !== undefined) patch.tools = tools;
    if (notifyUser !== undefined) patch.notifyUser = notifyUser;
    if (enabled !== undefined) patch.enabled = enabled;

    if (runAt !== undefined) {
      patch.schedule = { type: "once", runAt };
    }

    if (Object.keys(patch).length === 0) {
      return {
        success: false,
        error: "No editable fields were provided.",
      };
    }

    const updatedTask = await scheduler.updateTaskAsync(taskId, patch as any);

    if (updatedTask) {
      logger.info("[edit_once] Updated task details", {
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
    logger.error(`[${TOOL_NAME}] Failed to edit task: ${errorMessage}`, {
      taskId,
      patch: { name, description, tools, runAt, notifyUser, enabled },
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

export const editOnceTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: editOnceToolInputSchema,
  execute: createToolWithPrerequisites(
    "edit_once",
    TOOL_PREREQUISITES["edit_once"] || [],
    executeEditOnce,
  ) as any,
});

//#endregion Tool
