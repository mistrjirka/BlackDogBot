import { CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { filterInvalidTools } from "../utils/cron-tool-validation.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { IScheduledTask } from "../shared/types/index.js";

export interface ICronEditRequest {
  taskId: string;
  name?: string;
  description?: string;
  tools?: string[];
  notifyUser?: boolean;
  enabled?: boolean;
  messageDedupEnabled?: boolean;
}

export interface ICronEditResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

export interface ICronEditOptions {
  request: ICronEditRequest;
  scheduleType: "once" | "interval";
  toolName: string;
  wrongTypeMessage: string;
  errorPatch: Record<string, unknown>;
  buildSchedule?: (task: IScheduledTask) => IScheduledTask["schedule"];
  scheduleRequested?: boolean;
}

export async function executeCronEditAsync(options: ICronEditOptions): Promise<ICronEditResult> {
  const { request, scheduleType } = options;
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();
  const schedulerTimezone: string | undefined = ConfigService.getInstance().getConfig().scheduler.timezone;
  try {
    if (request.tools !== undefined) {
      const invalidTools: string[] = filterInvalidTools(request.tools);
      if (invalidTools.length > 0) {
        return { success: false, error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}` };
      }
    }
    const existingTask: IScheduledTask | undefined = await scheduler.getTaskAsync(request.taskId);
    if (!existingTask) return { success: false, error: `Task with ID '${request.taskId}' not found.` };
    if (existingTask.schedule.type !== scheduleType) return { success: false, error: options.wrongTypeMessage };
    const patch: Partial<IScheduledTask> = {};
    if (request.name !== undefined) patch.name = request.name;
    if (request.description !== undefined) patch.description = request.description;
    if (request.tools !== undefined) patch.tools = request.tools;
    if (request.notifyUser !== undefined) patch.notifyUser = request.notifyUser;
    if (request.enabled !== undefined) patch.enabled = request.enabled;
    if (request.messageDedupEnabled !== undefined) patch.messageDedupEnabled = request.messageDedupEnabled;
    if (options.buildSchedule && options.scheduleRequested) patch.schedule = options.buildSchedule(existingTask);
    if (Object.keys(patch).length === 0) return { success: false, error: "No editable fields were provided." };
    const updatedTask: IScheduledTask | undefined = await scheduler.updateTaskAsync(request.taskId, patch);
    if (updatedTask) logger.info(`[${options.toolName}] Updated task details`, { taskId: updatedTask.taskId, name: updatedTask.name, description: updatedTask.description, schedule: updatedTask.schedule, tools: updatedTask.tools, notifyUser: updatedTask.notifyUser, enabled: updatedTask.enabled, instructions: updatedTask.instructions, messageHistoryCount: updatedTask.messageHistory.length, updatedAt: updatedTask.updatedAt });
    return { success: true, task: updatedTask ?? undefined, display: updatedTask ? formatScheduledTask(updatedTask, schedulerTimezone) : undefined };
  } catch (error: unknown) {
    const errorMessage: string = extractErrorMessage(error);
    logger.error(`[${options.toolName}] Failed to edit task: ${errorMessage}`, { taskId: request.taskId, patch: options.errorPatch, error: errorMessage });
    return { success: false, error: errorMessage };
  }
}
