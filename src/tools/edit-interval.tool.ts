import { tool } from "ai";
import { editIntervalToolInputSchema, TOOL_PREREQUISITES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { resolveTimezone } from "../utils/time.js";
import { normalizeTimeParts } from "../utils/cron-format.js";
import { executeCronEditAsync, type ICronEditResult } from "./cron-edit-helper.js";
import type { IScheduledTask } from "../shared/types/index.js";
const TOOL_NAME: string = "edit_interval";
const TOOL_DESCRIPTION: string = "Modify an existing interval-based scheduled task. " + "You can patch non-instruction fields (name, description, tools, every, offsetFromDayStart, timezone, notifyUser, enabled). " + "send_message performs internal deduplication against previous cron messages. " + "IMPORTANT: You MUST call 'get_timed' first to retrieve the current task configuration before using this tool.";

interface IEditIntervalInput { taskId: string; name?: string; description?: string; tools?: string[]; every?: { hours?: number; minutes?: number }; offsetFromDayStart?: { hours?: number; minutes?: number }; timezone?: string; notifyUser?: boolean; enabled?: boolean; messageDedupEnabled?: boolean }
const executeEditInterval = async (input: IEditIntervalInput, _context: ToolExecuteContext): Promise<ICronEditResult> => {
  const { taskId, name, description, tools, every, offsetFromDayStart, timezone, notifyUser, enabled, messageDedupEnabled } = input;
  return executeCronEditAsync({ request: { taskId, name, description, tools, notifyUser, enabled, messageDedupEnabled }, scheduleType: "interval", toolName: TOOL_NAME, wrongTypeMessage: `Task '${taskId}' is not an 'interval' schedule type. Use edit_once for one-time tasks.`, errorPatch: { name, description, tools, every, offsetFromDayStart, timezone, notifyUser, enabled }, scheduleRequested: every !== undefined || offsetFromDayStart !== undefined || timezone !== undefined, buildSchedule: (existingTask: IScheduledTask) => {
    const current = existingTask.schedule;
    const currentEvery = current.type === "interval" ? current.every : { hours: 0, minutes: 0 };
    const currentOffset = current.type === "interval" ? current.offsetFromDayStart : { hours: 0, minutes: 0 };
    const requested = timezone ?? (current.type === "interval" ? current.timezone : "UTC");
    return { type: "interval", every: normalizeTimeParts({ hours: every?.hours ?? currentEvery.hours, minutes: every?.minutes ?? currentEvery.minutes }), offsetFromDayStart: normalizeTimeParts({ hours: offsetFromDayStart?.hours ?? currentOffset.hours, minutes: offsetFromDayStart?.minutes ?? currentOffset.minutes }), timezone: resolveTimezone(requested) };
  } });
};
export const editIntervalTool = tool({ description: TOOL_DESCRIPTION, inputSchema: editIntervalToolInputSchema, execute: createToolWithPrerequisites("edit_interval", TOOL_PREREQUISITES["edit_interval"] || [], executeEditInterval) as any });
