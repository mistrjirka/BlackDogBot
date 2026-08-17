import { tool } from "ai";
import { editOnceToolInputSchema, TOOL_PREREQUISITES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { wallClockToUtcIso, resolveTimezone } from "../utils/time.js";
import { ConfigService } from "../services/config.service.js";
import { executeCronEditAsync, type ICronEditResult } from "./cron-edit-helper.js";
import type { IScheduledTask } from "../shared/types/index.js";

const TOOL_NAME: string = "edit_once";
const TOOL_DESCRIPTION: string = "Modify an existing one-time scheduled task. " + "You can patch non-instruction fields (name, description, tools, year/month/day/hour/minute, notifyUser, enabled). " + "send_message performs internal deduplication against previous cron messages. " + "IMPORTANT: You MUST call 'get_timed' first to retrieve the current task configuration before using this tool.";

const executeEditOnce = async (input: { taskId: string; name?: string; description?: string; tools?: string[]; year?: number; month?: number; day?: number; hour?: number; minute?: number; notifyUser?: boolean; enabled?: boolean; messageDedupEnabled?: boolean }, _context: ToolExecuteContext): Promise<ICronEditResult> => {
  const { taskId, name, description, tools, year, month, day, hour, minute, notifyUser, enabled, messageDedupEnabled } = input;
  return executeCronEditAsync({ request: { taskId, name, description, tools, notifyUser, enabled, messageDedupEnabled }, scheduleType: "once", toolName: TOOL_NAME, wrongTypeMessage: `Task '${taskId}' is not a 'once' schedule type. Use edit_interval for interval tasks.`, errorPatch: { name, description, tools, year, month, day, hour, minute, notifyUser, enabled }, scheduleRequested: year !== undefined || month !== undefined || day !== undefined || hour !== undefined || minute !== undefined, buildSchedule: (existingTask: IScheduledTask) => {
    const schedulerTimezone: string = resolveTimezone(ConfigService.getInstance().getConfig().scheduler.timezone ?? "UTC");
    const currentRunAt: string = existingTask.schedule.type === "once" ? existingTask.schedule.runAt : new Date().toISOString();
    const parts: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-US", { timeZone: schedulerTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(currentRunAt))) if (["year","month","day","hour","minute"].includes(part.type)) parts[part.type] = parseInt(part.value, 10);
    return { type: "once", runAt: wallClockToUtcIso({ year: year ?? parts.year, month: month ?? parts.month, day: day ?? parts.day, hour: hour ?? (parts.hour === 24 ? 0 : parts.hour), minute: minute ?? parts.minute }, schedulerTimezone), offsetFromDayStart: { hours: 0, minutes: 0 }, timezone: schedulerTimezone };
  } });
};

export const editOnceTool = tool({ description: TOOL_DESCRIPTION, inputSchema: editOnceToolInputSchema, execute: createToolWithPrerequisites("edit_once", TOOL_PREREQUISITES["edit_once"] || [], executeEditOnce) as any });
