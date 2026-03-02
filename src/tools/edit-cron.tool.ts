import { tool } from "ai";
import { z } from "zod";
import { editCronToolInputSchema, TOOL_PREREQUISITES } from "../shared/schemas/tool-schemas.js";
import { CRON_TOOL_DESCRIPTIONS } from "../shared/constants/cron-descriptions.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditCronResult {
  success: boolean;
  task?: IScheduledTask;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "edit-cron";
const TOOL_DESCRIPTION: string =
  "Modify an existing scheduled task (cron job). " +
  "You can patch any subset of fields. If instructions are changed, they will be re-verified by the LLM. " +
  "IMPORTANT: You MUST call 'get_cron' first to retrieve the current task configuration before using this tool.";

//#endregion Const

//#region Tool

const executeEditCron = async (
  {
    taskId,
    ...patch
  }: {
    taskId: string;
    name?: string;
    description?: string;
    instructions?: string;
    tools?: string[];
    schedule?: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string };
    notifyUser?: boolean;
    enabled?: boolean;
  },
  _context: ToolExecuteContext,
): Promise<IEditCronResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();

  try {
    const existingTask = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Cron task with ID '${taskId}' not found.` };
    }

    // 1. Verify instructions using LLM IF they are being changed
    if (patch.instructions !== undefined) {
      logger.debug(`[${TOOL_NAME}] Re-verifying cron instructions for task: ${taskId}`);

      const toolsToVerify = patch.tools ?? existingTask.tools;
      const toolContextLines: string[] = toolsToVerify.map((t) => {
        const desc: string = CRON_TOOL_DESCRIPTIONS[t] ?? "(no description available)";
        return `  - ${t}: ${desc}`;
      });
      const toolContextBlock: string =
        toolContextLines.length > 0
          ? `The agent will have access to the following tools:\n${toolContextLines.join("\n")}`
          : "The agent will have no tools available.";

      const verifierPrompt = `
You are a task instruction verifier for an autonomous AI agent.
The agent runs periodically on a fixed schedule and has NO memory of past conversations when it wakes up.
The agent executing these instructions is an intelligent AI (an LLM). It can read tool descriptions, reason about conventions, compose arguments, and derive values — it is NOT a dumb script that needs every value pre-computed.

Your job: determine whether the instructions contain enough context for the agent to act independently WITHOUT guessing things that were only ever said in a prior conversation.

DEFAULT TO VALID. Only mark instructions invalid if there is a genuine, unresolvable ambiguity that would cause the agent to fail or act incorrectly.

${toolContextBlock}

RULES:

1. Schedule/timing is already encoded in the cron expression — do NOT require the instructions to re-state when or how often the task runs.

2. Tools that handle routing or delivery implicitly do NOT need extra config in the instructions.
   Example: "send_message" always reaches the correct user — instructions that say "send the results" or "notify the user" are VALID without specifying a chat ID or destination.

3. The agent can derive values from tool descriptions and standard conventions — do NOT flag these as missing:
   - Database file paths derived from a database name (e.g. "rageintel_news" → ~/.betterclaw/databases/rageintel_news.db)
   - Workspace file paths derived from a filename (e.g. "notes.txt" → ~/.betterclaw/workspace/notes.txt)
   - Any argument value that is directly stated in the tool description above

4. Criteria and rules do NOT need to be exhaustively rigid. An LLM agent can interpret general descriptions sensibly.
   Example: "mark items as interesting if the title contains breaking-news keywords" is VALID — the agent can decide what counts as a keyword.
   Example: "find recent news" is VALID if the agent can determine a reasonable time window from context.

5. Instructions ARE invalid if they rely on implicit conversational context the agent cannot know at runtime:
   - References to prior conversation: "fetch that feed", "do what we discussed", "the URL I mentioned"
   - Truly unspecified external resources: an RSS URL, API endpoint, or file path that is not provided AND cannot be derived from tool conventions

6. The "notifyUser" flag controls whether the agent's final text response is automatically forwarded to Telegram.
   - Set notifyUser=true when the user wants the agent's summary or results delivered to Telegram automatically (e.g. news digests, alerts, reports notifyUser=false for).
   - Set background tasks where only explicit send_message tool calls should reach Telegram (e.g. cleanup, archival, internal data processing).
   - The send_message tool ALWAYS sends to Telegram regardless of notifyUser — notifyUser only gates the automatic forwarding of the agent's final text output.

Instructions to verify:
"""
${patch.instructions}
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
      });

      if (!verificationResult.object.isClear) {
        const errorMsg = `EDIT REJECTED. The updated instructions are ambiguous or missing context: ${verificationResult.object.missingContext}. Please provide complete, self-contained instructions.`;
        logger.warn(`[${TOOL_NAME}] Edit rejected: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }
    }

    // 2. Update the task
    const updatedTask = await scheduler.updateTaskAsync(taskId, patch as any);

    return {
      success: true,
      task: updatedTask,
    };
  } catch (error: unknown) {
    const errorMessage: string = extractErrorMessage(error);
    logger.error(`[${TOOL_NAME}] Failed to edit cron task: ${errorMessage}`);

    return { success: false, error: errorMessage };
  }
};

export const editCronTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: editCronToolInputSchema,
  execute: createToolWithPrerequisites(
    "edit_cron",
    TOOL_PREREQUISITES["edit_cron"] || [],
    executeEditCron,
  ) as any,
});

//#endregion Tool
