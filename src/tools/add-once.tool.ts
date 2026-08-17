import { tool } from "ai";
import { addOnceToolInputSchema, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { filterInvalidTools } from "../utils/cron-tool-validation.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { buildTaskRecord, verifyCronInstructionsAsync } from "./cron-task-helper.js";
import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { wallClockToUtcIso, resolveTimezone } from "../utils/time.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

interface IAddOnceResult {
  taskId: string;
  success: boolean;
  displaySummary?: string;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "add_once";
const TOOL_DESCRIPTION: string =
  "Add a new ONE-TIME scheduled task that runs once at a specific date/time and then stops. " +
  "Use for: reminders, one-off alerts, single notifications. " +
  "Only use this when the user explicitly wants one execution at a specific date/time. " +
  "Required inputs: name, description, instructions, tools, year/month/day/hour/minute, notifyUser. " +
  "For RECURRING tasks (e.g., every hour, daily), use add_interval instead. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "If task instructions use table-storage tools, create required table(s) first using create_table, then reference explicit table names in the instructions.";

//#endregion Const

//#region Private methods

function _buildSchedule(
  params: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Schedule {
  const runAt: string = wallClockToUtcIso(params, timezone);
  return {
    type: "once",
    runAt,
    offsetFromDayStart: {
      hours: 0,
      minutes: 0,
    },
    timezone,
  };
}

//#endregion Private methods

//#region Tool

export const addOnceTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: addOnceToolInputSchema,
  execute: async ({
    name,
    description,
    instructions,
    tools,
    year,
    month,
    day,
    hour,
    minute,
    notifyUser,
    messageDedupEnabled,
  }: {
    name: string;
    description: string;
    instructions: string;
    tools: string[];
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    notifyUser: boolean;
    messageDedupEnabled?: boolean;
  }): Promise<IAddOnceResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const invalidTools: string[] = filterInvalidTools(tools);
      if (invalidTools.length > 0) {
        return {
          taskId: "",
          success: false,
          error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}`,
        };
      }

      logger.debug(`[${TOOL_NAME}] Verifying instructions for: ${name}`);

      const verificationResult = await verifyCronInstructionsAsync({
        instructions,
        tools,
        taskType: "once",
      });

      if (!verificationResult.isClear) {
        const errorMsg = `REJECTED. ${verificationResult.missingContext} → Solution: Embed the missing information directly into the \`instructions\` parameter. Scheduled agents have no access to external files unless you add explicit \`read_file\` steps.`;
        logger.warn(`[${TOOL_NAME}] Task rejected: ${errorMsg}`);
        return { taskId: "", success: false, error: errorMsg };
      }

      const configuredTimezone: string = ConfigService.getInstance().getConfig().scheduler.timezone ?? "UTC";
      const scheduleTimezone: string = resolveTimezone(configuredTimezone);

      const builtSchedule: Schedule = _buildSchedule({ year, month, day, hour, minute }, scheduleTimezone);

      const task: IScheduledTask = buildTaskRecord({
        name,
        description,
        instructions,
        tools,
        schedule: builtSchedule,
        notifyUser,
        messageDedupEnabled,
      });
      const taskId: string = task.taskId;

      await SchedulerService.getInstance().addTaskAsync(task);

      const formattedTime: string = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

      const displaySummary = `Created one-time task "${name}" (ID: ${taskId})\nSchedule: ${formattedTime}\nTools: [${tools.join(", ")}]`;

      return { taskId, success: true, displaySummary };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      logger.error(`[${TOOL_NAME}] Failed to add task: ${errorMessage}`);

      return { taskId: "", success: false, error: errorMessage };
    }
  },
});

//#endregion Tool
