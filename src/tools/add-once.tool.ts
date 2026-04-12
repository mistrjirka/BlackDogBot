import { tool } from "ai";
import { z } from "zod";
import { addOnceToolInputSchema, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { filterInvalidTools } from "../utils/cron-tool-validation.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateId } from "../utils/id.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
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
  const runAt: string = new Date(params.year, params.month - 1, params.day, params.hour, params.minute, 0, 0).toISOString();
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

      const toolContextBlock: string = await buildCronToolContextBlockAsync(tools);

      const verifierPrompt = `
You are a task instruction verifier for an autonomous AI agent.
The agent runs periodically on a fixed schedule and has NO memory of past conversations when it wakes up.
The agent executing these instructions is an intelligent AI (an LLM). It can read tool descriptions, reason about conventions, compose arguments, and derive values — it is NOT a dumb script that needs every value pre-computed.

Your job: determine whether the instructions contain enough context for the agent to act independently WITHOUT guessing things that were only ever said in a prior conversation.

DEFAULT TO VALID. Only mark instructions invalid if there is a genuine, unresolvable ambiguity that would cause the agent to fail or act incorrectly.

${toolContextBlock}

RULES:

1. Schedule/timing is already encoded in the task schedule fields — do NOT require the instructions to re-state when or how often the task runs.

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

7. **READ-ONLY vs. FETCH/WRITE TASK DISTINCTION:**
   - If instructions only READ from a database (e.g., "summarize items", "generate report", "send notification based on stored data"), they do NOT require an external source URL. The database IS their source. Mark as VALID.
   - If instructions FETCH from external sources (RSS, APIs, web) or WRITE to a database, they MUST specify source URLs AND target table schemas. Mark as INVALID if missing.

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
        const errorMsg = `REJECTED. ${verificationResult.object.missingContext} → Solution: Embed the missing information directly into the \`instructions\` parameter. Scheduled agents have no access to external files unless you add explicit \`read_file\` steps.`;
        logger.warn(`[${TOOL_NAME}] Task rejected: ${errorMsg}`);
        return { taskId: "", success: false, error: errorMsg };
      }

      const taskId: string = generateId();
      const now: string = new Date().toISOString();
      const configuredTimezone: string = ConfigService.getInstance().getConfig().scheduler.timezone ?? "UTC";
      const scheduleTimezone: string = (() => {
        try {
          Intl.DateTimeFormat("en-US", { timeZone: configuredTimezone }).format(new Date());
          return configuredTimezone;
        } catch {
          return "UTC";
        }
      })();

      const builtSchedule: Schedule = _buildSchedule({ year, month, day, hour, minute }, scheduleTimezone);

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
