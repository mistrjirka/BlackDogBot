import { tool } from "ai";
import { z } from "zod";
import { addIntervalToolInputSchema, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { filterInvalidTools } from "../utils/cron-tool-validation.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateId } from "../utils/id.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import { buildCronTaskVerifierPrompt } from "../utils/cron-task-verifier.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

interface IAddIntervalResult {
  taskId: string;
  success: boolean;
  displaySummary?: string;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "add_interval";
const TOOL_DESCRIPTION: string =
  "Add a new RECURRING scheduled task that runs repeatedly at fixed intervals until deleted. " +
  "Use for: periodic monitoring, recurring reports, ongoing data collection. " +
  "If uncertain whether a request is recurring or one-time, default to this tool. " +
  "Required inputs: name, description, instructions, tools, every (hours/minutes), offsetFromDayStart (hours/minutes), notifyUser. " +
  "Optional inputs: timezone. " +
  "Common intervals: every={hours:1,minutes:0}, every={hours:2,minutes:0}, every={hours:24,minutes:0}. " +
  "For ONE-TIME tasks (runs once), use add_once instead. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "If task instructions use table-storage tools, create required table(s) first using create_table, then reference explicit table names in the instructions.";

//#endregion Const

//#region Private methods

function _buildSchedule(
  every: { hours: number; minutes: number },
  offsetFromDayStart: { hours: number; minutes: number },
  timezone: string,
): Schedule {
  return {
    type: "interval",
    every,
    offsetFromDayStart,
    timezone,
  };
}

function _normalizeTimeParts(
  parts: { hours: number; minutes: number },
): { hours: number; minutes: number } {
  const safeHours: number = Math.max(0, parts.hours);
  const safeMinutes: number = Math.max(0, parts.minutes);
  const totalMinutes: number = (safeHours * 60) + safeMinutes;
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

//#endregion Private methods

//#region Tool

export const addIntervalTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: addIntervalToolInputSchema,
  execute: async ({
    name,
    description,
    instructions,
    tools,
    every,
    offsetFromDayStart,
    timezone,
    notifyUser,
    messageDedupEnabled,
  }: {
    name: string;
    description: string;
    instructions: string;
    tools: string[];
    every: { hours: number; minutes: number };
    offsetFromDayStart: { hours: number; minutes: number };
    timezone?: string;
    notifyUser: boolean;
    messageDedupEnabled?: boolean;
  }): Promise<IAddIntervalResult> => {
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

     const toolContextBlock: string = await buildCronToolContextBlockAsync(tools);

      const verifierPrompt: string = buildCronTaskVerifierPrompt({
        instructions,
        toolContextBlock,
        taskType: "interval",
      });

      const aiService = AiProviderService.getInstance();
      const model = aiService.getModel();

      const verificationResult = await generateObjectWithRetryAsync({
        model,
        schema: z.object({
          isClear: z.boolean(),
          missingContext: z.string(),
        }),
        prompt: verifierPrompt,
        retryOptions: { callType: "schema_extraction" },
      });

      if (!verificationResult.object.isClear) {
        const errorMsg = `REJECTED. ${verificationResult.object.missingContext} → Solution: Embed the missing information directly into the \`instructions\` parameter. Scheduled agents have no access to external files unless you add explicit \`read_file\` steps.`;
        logger.warn(`[${TOOL_NAME}] Task rejected: ${errorMsg}`);
        return { taskId: "", success: false, error: errorMsg };
      }

      const effectiveOffsetFromDayStart: { hours: number; minutes: number } =
        _normalizeTimeParts(offsetFromDayStart);

      const taskId: string = generateId();
      const now: string = new Date().toISOString();
      const requestedTimezone: string = timezone ?? ConfigService.getInstance().getConfig().scheduler.timezone ?? "UTC";
      const effectiveTimezone: string = (() => {
        try {
          Intl.DateTimeFormat("en-US", { timeZone: requestedTimezone }).format(new Date());
          return requestedTimezone;
        } catch {
          return "UTC";
        }
      })();
      const builtSchedule: Schedule = _buildSchedule(
        every,
        effectiveOffsetFromDayStart,
        effectiveTimezone,
      );

      const task: IScheduledTask = {
        taskId,
        name,
        description,
        instructions,
        tools,
        schedule: builtSchedule,
        notifyUser,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
        messageHistory: [],
        messageSummary: null,
        summaryGeneratedAt: null,
        messageDedupEnabled: messageDedupEnabled ?? true,
      };

      await SchedulerService.getInstance().addTaskAsync(task);

      const offsetStr: string =
        effectiveOffsetFromDayStart.hours > 0 || effectiveOffsetFromDayStart.minutes > 0
          ? ` (+${effectiveOffsetFromDayStart.hours}h ${effectiveOffsetFromDayStart.minutes}m from day start)`
          : "";

      const displaySummary =
        `Created interval task "${name}" (ID: ${taskId})\n` +
        `Schedule: every ${every.hours}h ${every.minutes}m${offsetStr} (${effectiveTimezone})\n` +
        `Tools: [${tools.join(", ")}]`;

      return { taskId, success: true, displaySummary };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      logger.error(`[${TOOL_NAME}] Failed to add task: ${errorMessage}`);

      return { taskId: "", success: false, error: errorMessage };
    }
  },
});

//#endregion Tool
