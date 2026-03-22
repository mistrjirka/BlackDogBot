import { tool } from "ai";
import { z } from "zod";
import { editCronToolInputSchema, TOOL_PREREQUISITES, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditCronResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "edit-cron";
const TOOL_DESCRIPTION: string =
  "Modify an existing scheduled task (cron job). " +
  "You can patch any subset of fields. If instructions are changed, they will be re-verified by the LLM. " +
  "If tools include send_message, get_previous_message is auto-included at runtime so the cron can deduplicate notifications against previous cron messages. " +
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
    instructionChangeWhat?: string;
    instructionChangeWhy?: string;
    tools?: string[];
    scheduleType?: "once" | "interval" | "cron";
    scheduleRunAt?: string;
    scheduleIntervalMs?: number;
    scheduleCron?: string;
    notifyUser?: boolean;
    enabled?: boolean;
  },
  _context: ToolExecuteContext,
): Promise<IEditCronResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();

  try {
    // 0. Validate tool names at runtime (if provided)
    if (patch.tools !== undefined) {
      const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
      const isDynamicWriteTableTool = (toolName: string): boolean => toolName.startsWith("write_table_");
      const invalidTools: string[] = patch.tools.filter(
        (t) => !validToolSet.has(t) && !isDynamicWriteTableTool(t),
      );
      if (invalidTools.length > 0) {
        return {
          success: false,
          error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}`,
        };
      }
    }

    const existingTask = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Cron task with ID '${taskId}' not found.` };
    }

    // 1. Detect whether instructions actually changed
    const instructionsActuallyChanged: boolean =
      patch.instructions !== undefined &&
      patch.instructions.trim() !== existingTask.instructions.trim();

    // 2. Require change metadata when instructions change
    if (instructionsActuallyChanged) {
      if (!patch.instructionChangeWhat || patch.instructionChangeWhat.trim().length === 0) {
        return {
          success: false,
          error: "instructionChangeWhat is required when changing instructions. Describe what is being changed and how.",
        };
      }
      if (!patch.instructionChangeWhy || patch.instructionChangeWhy.trim().length === 0) {
        return {
          success: false,
          error: "instructionChangeWhy is required when changing instructions. Explain why this change is needed.",
        };
      }
    }

    // 3. Verify instructions using LLM IF they are actually being changed
      if (instructionsActuallyChanged) {
        logger.debug(`[${TOOL_NAME}] Re-verifying cron instructions for task: ${taskId}`);

      const toolsToVerify = patch.tools ?? existingTask.tools;
      const toolContextBlock: string = await buildCronToolContextBlockAsync(toolsToVerify);

      const proposedSchedule: Record<string, unknown> = { type: existingTask.schedule.type };
      if (existingTask.schedule.type === "once") {
        proposedSchedule.runAt = patch.scheduleRunAt !== undefined ? patch.scheduleRunAt : existingTask.schedule.runAt;
      } else if (existingTask.schedule.type === "interval") {
        proposedSchedule.intervalMs = patch.scheduleIntervalMs !== undefined ? patch.scheduleIntervalMs : existingTask.schedule.intervalMs;
      } else {
        proposedSchedule.expression = patch.scheduleCron !== undefined ? patch.scheduleCron : existingTask.schedule.expression;
      }

      const proposedTools: string[] = patch.tools ?? existingTask.tools;
      const proposedNotifyUser: boolean = patch.notifyUser !== undefined ? patch.notifyUser : existingTask.notifyUser;
      const proposedEnabled: boolean = patch.enabled !== undefined ? patch.enabled : existingTask.enabled;
      const proposedName: string = patch.name !== undefined ? patch.name : existingTask.name;
      const proposedDescription: string = patch.description !== undefined ? patch.description : existingTask.description;

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
   IMPORTANT: If the cron has send_message in its tools list, get_previous_message is auto-included at runtime.
   The agent should use get_previous_message to avoid sending notifications with the same meaning as previous cron messages unless explicitly asked to repeat.

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

=== OLD CRON TASK ===
Task ID: ${existingTask.taskId}
Name: ${existingTask.name}
Description: ${existingTask.description}
Schedule: ${JSON.stringify(existingTask.schedule)}
Tools: ${existingTask.tools.join(", ")}
notifyUser: ${existingTask.notifyUser}
Enabled: ${existingTask.enabled}

Old Instructions:
"""
${existingTask.instructions}
"""

=== PROPOSED NEW CRON TASK ===
Task ID: ${existingTask.taskId}
Name: ${proposedName}
Description: ${proposedDescription}
Schedule: ${JSON.stringify(proposedSchedule)}
Tools: ${proposedTools.join(", ")}
notifyUser: ${proposedNotifyUser}
Enabled: ${proposedEnabled}

New Instructions:
"""
${patch.instructions}
"""

=== CHANGE RATIONALE ===
What changed: ${patch.instructionChangeWhat}
Why changed: ${patch.instructionChangeWhy}

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
        const errorMsg =
          `EDIT REJECTED. The updated instructions were not approved by the verifier.\n\n` +
          `Verifier reason: ${verificationResult.object.missingContext}\n\n` +
          `Old instructions:\n${existingTask.instructions}\n\n` +
          `Proposed instructions:\n${patch.instructions}\n\n` +
          `Change what: ${patch.instructionChangeWhat}\n\n` +
          `Change why: ${patch.instructionChangeWhy}`;
        logger.warn(`[${TOOL_NAME}] Edit rejected`, {
          taskId,
          reason: verificationResult.object.missingContext,
        });

        logger.error("[edit-cron] Rejected update details", {
          taskId,
          oldTask: {
            taskId: existingTask.taskId,
            name: existingTask.name,
            description: existingTask.description,
            schedule: existingTask.schedule,
            tools: existingTask.tools,
            notifyUser: existingTask.notifyUser,
            enabled: existingTask.enabled,
            instructions: existingTask.instructions,
          },
          proposedPatch: {
            ...patch,
          },
          verifierReason: verificationResult.object.missingContext,
        });

        return { success: false, error: errorMsg };
      }
    }

    // 4. Build update payload — reconstruct schedule object from flat params
    //    instructionChangeWhat/Why are metadata only, not persisted in task.
    const { scheduleType, scheduleRunAt, scheduleIntervalMs, scheduleCron, instructionChangeWhat, instructionChangeWhy, ...restPatch } = patch;
    const updatePayload: Record<string, unknown> = { ...restPatch };

    if (scheduleType !== undefined) {
      // Schedule type is immutable. Ignore requested type changes and preserve existing type.
      if (scheduleType !== existingTask.schedule.type) {
        logger.debug(`[${TOOL_NAME}] Ignoring scheduleType change request`, {
          taskId,
          requestedType: scheduleType,
          existingType: existingTask.schedule.type,
        });
      }

      const schedule: Record<string, unknown> = { type: existingTask.schedule.type };

      if (existingTask.schedule.type === "once") {
        schedule.runAt = scheduleRunAt !== undefined ? scheduleRunAt : existingTask.schedule.runAt;
      } else if (existingTask.schedule.type === "interval") {
        schedule.intervalMs = scheduleIntervalMs !== undefined ? scheduleIntervalMs : existingTask.schedule.intervalMs;
      } else {
        schedule.expression = scheduleCron !== undefined ? scheduleCron : existingTask.schedule.expression;
      }

      updatePayload.schedule = schedule;
    } else if (scheduleRunAt !== undefined || scheduleIntervalMs !== undefined || scheduleCron !== undefined) {
      // Allow schedule value-only edits without requiring scheduleType.
      const schedule: Record<string, unknown> = { type: existingTask.schedule.type };

      if (existingTask.schedule.type === "once") {
        schedule.runAt = scheduleRunAt !== undefined ? scheduleRunAt : existingTask.schedule.runAt;
      } else if (existingTask.schedule.type === "interval") {
        schedule.intervalMs = scheduleIntervalMs !== undefined ? scheduleIntervalMs : existingTask.schedule.intervalMs;
      } else {
        schedule.expression = scheduleCron !== undefined ? scheduleCron : existingTask.schedule.expression;
      }

      updatePayload.schedule = schedule;
    }

    const updatedTask = await scheduler.updateTaskAsync(taskId, updatePayload as any);

    if (updatedTask) {
      logger.info("[edit-cron] Updated task details", {
        taskId: updatedTask.taskId,
        name: updatedTask.name,
        description: updatedTask.description,
        schedule: updatedTask.schedule,
        tools: updatedTask.tools,
        notifyUser: updatedTask.notifyUser,
        enabled: updatedTask.enabled,
        instructions: updatedTask.instructions,
        messageHistoryCount: updatedTask.messageHistory.length,
        updatedAt: updatedTask.updatedAt,
      });
    }

    return {
      success: true,
      task: updatedTask,
      display: updatedTask ? formatScheduledTask(updatedTask) : undefined,
    };
  } catch (error: unknown) {
    const errorMessage: string = extractErrorMessage(error);
    logger.error(`[${TOOL_NAME}] Failed to edit cron task: ${errorMessage}`, {
      taskId,
      patch,
      error: errorMessage,
    });

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
