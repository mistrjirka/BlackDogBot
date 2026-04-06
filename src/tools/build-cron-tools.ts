import { tool } from "langchain";
import type { DynamicStructuredTool } from "langchain";
import { z } from "zod";

import {
  addCronToolInputSchema,
  editCronToolInputSchema,
  editCronInstructionsToolInputSchema,
  CRON_VALID_TOOL_NAMES,
} from "../shared/schemas/tool-schemas.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import { LoggerService } from "../services/logger.service.js";
import { executeAddCronAsync } from "./add-cron.tool.js";
import { executeEditCronAsync } from "./edit-cron.tool.js";
import { executeEditCronInstructionsAsync } from "./edit-cron-instructions.tool.js";

//#region Interfaces

export interface ICronTools {
  add_cron: DynamicStructuredTool;
  edit_cron: DynamicStructuredTool;
  edit_cron_instructions: DynamicStructuredTool;
}

//#endregion Interfaces

//#region Constants

const ADD_CRON_DESCRIPTION: string =
  "Add a new scheduled task (cron job) to the scheduler. " +
  "Required inputs: name, description, instructions, tools, scheduleType, notifyUser. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "Schedule-specific required input: scheduleRunAt for scheduleType='once', scheduleIntervalMs for scheduleType='interval', scheduleIntervalMinutes for scheduleType='scheduled'. " +
  "For scheduled tasks: scheduleIntervalMinutes is required. Common values: 2=every 2min, 5=every 5min, 10=every 10min, 15=every 15min, 30=every 30min, 60=hourly, 120=every 2h, 180=every 3h, 240=every 4h, 360=every 6h, 720=every 12h, 1440=daily, 2880=every 2 days, 10080=weekly. " +
  "Optional: scheduleStartHour (0-23) and scheduleStartMinute (0-59) to anchor the interval to a specific time of day. " +
  "scheduleStartMinute is a minute offset within the hour (0-59), NOT hours. E.g., startMinute=2 means ':02 of each hour'. " +
  "Examples: once => scheduleRunAt='2026-03-20T08:00:00Z'; interval => scheduleIntervalMs=7200000; " +
  "scheduled (daily at 9 AM) => scheduleIntervalMinutes=1440, scheduleStartHour=9, scheduleStartMinute=0; " +
  "scheduled (every 2h at :30) => scheduleIntervalMinutes=120, scheduleStartMinute=30; " +
  "scheduled (every 2min) => scheduleIntervalMinutes=2 (no startHour/startMinute). " +
  "If the task's instructions reference a database, ensure the database and table(s) have been created first using create_database and create_table, then reference them by name (without .db extension) in the instructions.";

const EDIT_CRON_DESCRIPTION: string =
  "Modify an existing scheduled task (cron job). " +
  "You can patch non-instruction fields (name, description, tools, schedule values, notifyUser, enabled). " +
  "To change instructions, use edit_cron_instructions with the COMPLETE new instructions text. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "IMPORTANT: You MUST call 'get_cron' first to retrieve the current task configuration before using this tool.";

const EDIT_CRON_INSTRUCTIONS_DESCRIPTION: string =
  "Update ONLY the instructions text of an existing cron task. " +
  "You MUST provide the COMPLETE new instructions text in the 'instructions' field (full replacement), plus 'intention' explaining why the change is needed. " +
  "Optionally provide 'tools' to replace the task tool list in the same call when instruction changes require different tools. " +
  "IMPORTANT: 'intention' is metadata only and does NOT change instructions by itself. " +
  "IMPORTANT: You MUST call 'get_cron' first to retrieve the current task configuration before using this tool.";

//#endregion Constants

//#endregion Private Functions

//#region Private Helper Functions

async function buildCronSchemasAsync(): Promise<{
  addCronInputSchema: z.ZodObject<any>;
  editCronInputSchema: z.ZodObject<any>;
  editCronInstructionsInputSchema: z.ZodObject<any>;
}> {
  const perTableTools: Record<string, DynamicStructuredTool> = await buildPerTableToolsAsync();
  const writeTableToolNames: string[] = Object.keys(perTableTools).filter((name: string): boolean =>
    name.startsWith("write_table_"),
  );
  const updateTableToolNames: string[] = Object.keys(perTableTools).filter((name: string): boolean =>
    name.startsWith("update_table_"),
  );

  const allToolNames: [string, ...string[]] = [
    CRON_VALID_TOOL_NAMES[0],
    ...CRON_VALID_TOOL_NAMES.slice(1),
    ...writeTableToolNames,
    ...updateTableToolNames,
  ] as [string, ...string[]];
  const toolsEnum: z.ZodEnum<[string, ...string[]]> = z.enum(allToolNames);

  const logger: LoggerService = LoggerService.getInstance();
  logger.debug("[buildCronTools] Built dynamic tools enum", {
    staticToolCount: CRON_VALID_TOOL_NAMES.length,
    writeTableToolCount: writeTableToolNames.length,
    updateTableToolCount: updateTableToolNames.length,
    totalToolCount: allToolNames.length,
  });

  const toolsFieldDescription: string = `Valid tools: ${allToolNames.join(", ")}. send_message performs internal deduplication against previous cron messages.`;

  const addCronInputSchema: z.ZodObject<any> = (addCronToolInputSchema._def as any).schema.extend({
    tools: z.array(toolsEnum)
      .min(1)
      .describe(`Tool names available to the task agent (required, at least one). ${toolsFieldDescription}`),
  });

  const editCronInputSchema: z.ZodObject<any> = editCronToolInputSchema.extend({
    tools: z.array(toolsEnum)
      .min(1)
      .optional()
      .describe(`Updated list of available tool names. ${toolsFieldDescription}`),
  });

  const editCronInstructionsInputSchema: z.ZodObject<any> = editCronInstructionsToolInputSchema.extend({
    tools: z.array(toolsEnum)
      .min(1)
      .optional()
      .describe(`Optional replacement tool list to apply together with the instruction update. ${toolsFieldDescription}`),
  });

  return {
    addCronInputSchema,
    editCronInputSchema,
    editCronInstructionsInputSchema,
  };
}

//#endregion Private Helper Functions

//#region Public Functions

export async function buildCronToolsAsync(): Promise<ICronTools> {
  const {
    addCronInputSchema,
    editCronInputSchema,
    editCronInstructionsInputSchema,
  } = await buildCronSchemasAsync();

  const addCronToolInstance: DynamicStructuredTool = tool(
    executeAddCronAsync,
    {
      name: "add_cron",
      description: ADD_CRON_DESCRIPTION,
      schema: addCronInputSchema,
    },
  );

  const editCronToolInstance: DynamicStructuredTool = tool(
    executeEditCronAsync,
    {
      name: "edit_cron",
      description: EDIT_CRON_DESCRIPTION,
      schema: editCronInputSchema,
    },
  );

  const editCronInstructionsToolInstance: DynamicStructuredTool = tool(
    executeEditCronInstructionsAsync,
    {
      name: "edit_cron_instructions",
      description: EDIT_CRON_INSTRUCTIONS_DESCRIPTION,
      schema: editCronInstructionsInputSchema,
    },
  );

  return {
    add_cron: addCronToolInstance,
    edit_cron: editCronToolInstance,
    edit_cron_instructions: editCronInstructionsToolInstance,
  };
}

//#endregion Public Functions
