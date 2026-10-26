import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";

import {
  addOnceToolInputSchema,
  addIntervalToolInputSchema,
  editOnceToolInputSchema,
  editIntervalToolInputSchema,
  runCmdInputToolInputSchema,
  getCmdStatusToolInputSchema,
  getCmdOutputToolInputSchema,
  waitForCmdToolInputSchema,
  stopCmdToolInputSchema,
} from "../shared/schemas/tool-schemas.js";
import { addOnceTool } from "./add-once.tool.js";
import { addIntervalTool } from "./add-interval.tool.js";
import { editOnceTool } from "./edit-once.tool.js";
import { editIntervalTool } from "./edit-interval.tool.js";
import { runCmdInputTool } from "./run-cmd-input.tool.js";
import { getCmdStatusTool } from "./get-cmd-status.tool.js";
import { getCmdOutputTool } from "./get-cmd-output.tool.js";
import { waitForCmdTool } from "./wait-for-cmd.tool.js";
import { stopCmdTool } from "./stop-cmd.tool.js";

type LegacyTool = Tool<unknown, unknown>;

/** Preserve existing implementation and validation, with a smaller, stable
 * discriminator-based model-facing interface. Legacy tools remain exported
 * for cron runners and older tasks but are not advertised to chat models. */
async function dispatch(
  original: LegacyTool,
  values: Record<string, unknown>,
  options: ToolExecutionOptions<unknown>,
): Promise<unknown> {
  if (!original.execute) return { success: false, error: "Tool execution unavailable" };
  return await original.execute(values, options);
}

const timePart = z.object({ hours: z.number().int(), minutes: z.number().int() });

const scheduleCommon = {
  kind: z.enum(["once", "interval"]).describe("Once = single date/time; interval = recurring"),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).min(1).optional(),
  year: z.number().int().optional(),
  month: z.number().int().optional(),
  day: z.number().int().optional(),
  hour: z.number().int().optional(),
  minute: z.number().int().optional(),
  every: timePart.optional(),
  offsetFromDayStart: timePart.optional(),
  timezone: z.string().optional(),
  notifyUser: z.boolean().optional(),
  messageDedupEnabled: z.boolean().optional(),
};

export const scheduleCreateTool = tool({
  description: "Create one scheduled task. kind=once needs year/month/day/hour/minute; kind=interval needs every and offsetFromDayStart. Include self-contained instructions and permitted tools.",
  inputSchema: z.object(scheduleCommon),
  execute: async (input, options) => {
    const { kind, ...rest } = input;
    const schema = kind === "once" ? addOnceToolInputSchema : addIntervalToolInputSchema;
    const result = schema.safeParse(rest);
    if (!result.success) return { success: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    return dispatch((kind === "once" ? addOnceTool : addIntervalTool) as LegacyTool, result.data, options);
  },
});

export const scheduleEditTool = tool({
  description: "Edit a saved task after get_timed. kind=once edits its date/time; kind=interval edits its recurrence. Use edit_instructions separately for its instructions.",
  inputSchema: z.object({ ...scheduleCommon, taskId: z.string().min(1) }).omit({ instructions: true }),
  execute: async (input, options) => {
    const { kind, ...rest } = input;
    const schema = kind === "once" ? editOnceToolInputSchema : editIntervalToolInputSchema;
    const result = schema.safeParse(rest);
    if (!result.success) return { success: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    return dispatch((kind === "once" ? editOnceTool : editIntervalTool) as LegacyTool, result.data, options);
  },
});

export const processTool = tool({
  description: "Manage an existing background run_cmd handle. action=status, output, wait, input or stop. Input accepts text or controlKey (CTRL_C, CTRL_D, TAB etc.). Wait doesn't kill processes.",
  inputSchema: z.object({
    action: z.enum(["status", "output", "wait", "input", "stop"]),
    handleId: z.string().min(1),
    input: z.string().optional(),
    controlKey: z.enum(["CTRL_C", "CTRL_D", "CTRL_U", "TAB", "ENTER", "ESCAPE", "DELETE"]).optional(),
    appendNewline: z.boolean().optional(),
    closeStdin: z.boolean().optional(),
    channel: z.enum(["stdout", "stderr", "both"]).optional(),
    maxBytes: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).optional(),
  }),
  execute: async ({ action, ...input }, options) => {
    const entry = {
      status: { schema: getCmdStatusToolInputSchema, legacy: getCmdStatusTool },
      output: { schema: getCmdOutputToolInputSchema, legacy: getCmdOutputTool },
      wait: { schema: waitForCmdToolInputSchema, legacy: waitForCmdTool },
      input: { schema: runCmdInputToolInputSchema, legacy: runCmdInputTool },
      stop: { schema: stopCmdToolInputSchema, legacy: stopCmdTool },
    }[action];
    const parsed = entry.schema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    return dispatch(entry.legacy as LegacyTool, parsed.data, options);
  },
});
