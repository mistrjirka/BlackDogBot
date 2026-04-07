import { tool } from "ai";
import { z } from "zod";
import { addScheduledTaskToolInputSchema, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateId } from "../utils/id.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IAddScheduledTaskResult {
  taskId: string;
  success: boolean;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "add_scheduled_task";
const TOOL_DESCRIPTION: string =
  "Add a new scheduled task to the scheduler. " +
  "Required inputs: name, description, instructions, tools, scheduleIntervalMinutes, notifyUser. " +
  "send_message performs internal deduplication against previous scheduled task messages. " +
  "Schedule inputs: scheduleIntervalMinutes (required, minutes between runs), scheduleStartHour (optional, 0-23), scheduleStartMinute (optional, 0-59), runOnce (optional, default false). " +
  "Examples: every 2 hours => scheduleIntervalMinutes=120; daily at 8am => scheduleIntervalMinutes=1440, scheduleStartHour=8, scheduleStartMinute=0; one-time => scheduleIntervalMinutes=1440, runOnce=true. " +
  "If the task's instructions reference a database, ensure the database and table(s) have been created first using create_database and create_table, then reference them by name (without .db extension) in the instructions.";

//#endregion Const

//#region Private methods

function _buildSchedule(input: {
  scheduleIntervalMinutes: number;
  scheduleStartHour?: number;
  scheduleStartMinute?: number;
  runOnce?: boolean;
}): IScheduledTask["schedule"] {
  return {
    type: "scheduled" as const,
    intervalMinutes: input.scheduleIntervalMinutes,
    startHour: input.scheduleStartHour ?? null,
    startMinute: input.scheduleStartMinute ?? null,
    runOnce: input.runOnce ?? false,
  };
}

//#endregion Private methods

//#region Tool

export const addScheduledTaskTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: addScheduledTaskToolInputSchema,
  execute: async ({
    name,
    description,
    instructions,
    tools,
    scheduleIntervalMinutes,
    scheduleStartHour,
    scheduleStartMinute,
    runOnce,
    notifyUser,
  }: {
    name: string;
    description: string;
    instructions: string;
    tools: string[];
    scheduleIntervalMinutes: number;
    scheduleStartHour?: number;
    scheduleStartMinute?: number;
    runOnce?: boolean;
    notifyUser: boolean;
  }): Promise<IAddScheduledTaskResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      // 0. Validate tool names at runtime
      const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
      const isDynamicWriteTableTool = (toolName: string): boolean => toolName.startsWith("write_table_");
      const invalidTools: string[] = tools.filter(
        (t) => !validToolSet.has(t) && !isDynamicWriteTableTool(t),
      );
      if (invalidTools.length > 0) {
        return {
          taskId: "",
          success: false,
          error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}`,
        };
      }

      // 1. Verify instructions using LLM
      logger.debug(`[${TOOL_NAME}] Verifying scheduled task instructions for: ${name}`);

      // Build a human-readable tool list so the verifier knows what each tool does.
      // This prevents it from flagging well-known tools (e.g. send_message) as
      // "unresolved destinations" simply because it has no context about them.
      const toolContextBlock: string = await buildCronToolContextBlockAsync(tools);

      const verifierPrompt = `
You are a task instruction verifier for an autonomous AI agent.
The agent runs periodically on a fixed schedule and has NO memory of past conversations when it wakes up.
The agent executing these instructions is an intelligent AI (an LLM). It can read tool descriptions, reason about conventions, compose arguments, and derive values — it is NOT a dumb script that needs every value pre-computed.

Your job: determine whether the instructions contain enough context for the agent to act independently WITHOUT guessing things that were only ever said in a prior conversation.

DEFAULT TO VALID. Only mark instructions invalid if there is a genuine, unresolvable ambiguity that would cause the agent to fail or act incorrectly.

${toolContextBlock}

RULES:

1. Schedule/timing is already encoded in the schedule — do NOT require the instructions to re-state when or how often the task runs.

2. Tools that handle routing or delivery implicitly do NOT need extra config in the instructions.
   Example: "send_message" always reaches the correct user — instructions that say "send the results" or "notify the user" are VALID without specifying a chat ID or destination.
   send_message performs internal deduplication and skips notifications that do not add new information.

3. The agent can derive values from tool descriptions and standard conventions — do NOT flag these as missing:

   - Workspace file paths derived from a filename (e.g. "notes.txt" → ~/.blackdogbot/workspace/notes.txt)
   - Any argument value that is directly stated in the tool description above

4. Criteria and rules do NOT need to be exhaustively rigid. An LLM agent can interpret general descriptions sensibly.
   Example: "mark items as interesting if the title contains breaking-news keywords" is VALID — the agent can decide what counts as a keyword.
   Example: "find recent news" is VALID if the agent can determine a reasonable time window from context.

5. Instructions ARE invalid if they rely on implicit conversational context the agent cannot know at runtime:
   - References to prior conversation: "fetch that feed", "do what we discussed", "the URL I mentioned"
   - Truly unspecified external resources: an RSS URL, API endpoint, or file path that is not provided AND cannot be derived from tool conventions

6. The "notifyUser" flag controls whether the agent's final text response is automatically forwarded to Telegram.
   - Set notifyUser=true when the user wants the agent's summary or results delivered to Telegram automatically (e.g. news digests, alerts, reports).
   - Set notifyUser=false for background tasks where only explicit send_message tool calls should reach Telegram (e.g. cleanup, archival, internal data processing).
   - The send_message tool ALWAYS sends to Telegram regardless of notifyUser — notifyUser only gates the automatic forwarding of the agent's final text output.

Instructions to verify:
"""
${instructions}
"""

Output a JSON object with:
- "isClear": boolean (true if valid, false if invalid)
- "missingContext": string (if invalid, describe exactly what information is missing and why it cannot be derived; if valid, use empty string)
`;

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
        const errorMsg = `SCHEDULED TASK REJECTED. The instructions are ambiguous or missing context: ${verificationResult.object.missingContext}. Please provide complete, self-contained instructions.`;
        logger.warn(`[${TOOL_NAME}] Scheduled task rejected: ${errorMsg}`);
        return { taskId: "", success: false, error: errorMsg };
      }

      // 2. Schedule the task
      const taskId: string = generateId();
      const now: string = new Date().toISOString();
      const builtSchedule: IScheduledTask["schedule"] = _buildSchedule({
        scheduleIntervalMinutes,
        scheduleStartHour,
        scheduleStartMinute,
        runOnce,
      });

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
      };

      await SchedulerService.getInstance().addTaskAsync(task);

      return { taskId, success: true };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      logger.error(`[${TOOL_NAME}] Failed to add scheduled task: ${errorMessage}`);

      return { taskId: "", success: false, error: errorMessage };
    }
  },
});

//#endregion Tool