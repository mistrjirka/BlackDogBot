import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  addCronToolInputSchema,
  editCronToolInputSchema,
  editCronInstructionsToolInputSchema,
  CRON_VALID_TOOL_NAMES,
} from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { generateId } from "../utils/id.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

export interface ICronTools {
  add_cron: Tool<any, any>;
  edit_cron: Tool<any, any>;
  edit_cron_instructions: Tool<any, any>;
}

interface IAddCronResult {
  taskId: string;
  success: boolean;
  error?: string;
}

interface IEditCronResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

interface IEditCronInstructionsResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Constants

const ADD_CRON_DESCRIPTION: string =
  "Add a new scheduled task (cron job) to the scheduler. " +
  "Required inputs: name, description, instructions, tools, scheduleType, notifyUser. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "Schedule-specific required input: scheduleRunAt for scheduleType='once', scheduleIntervalMs for scheduleType='interval', scheduleCron for scheduleType='cron'. " +
  "Examples: once => scheduleRunAt='2026-03-20T08:00:00Z'; interval => scheduleIntervalMs=7200000; cron => scheduleCron='0 */2 * * *'. " +
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

//#region Private Helper Functions

function buildSchedule(input: {
  scheduleType: "once" | "interval" | "cron";
  scheduleRunAt?: string;
  scheduleIntervalMs?: number;
  scheduleCron?: string;
}): Schedule {
  switch (input.scheduleType) {
    case "once": {
      if (!input.scheduleRunAt || input.scheduleRunAt.trim().length === 0) {
        throw new Error("scheduleRunAt is required for scheduleType='once'");
      }
      return {
        type: "once",
        runAt: input.scheduleRunAt,
      };
    }
    case "interval": {
      if (input.scheduleIntervalMs === undefined || !Number.isFinite(input.scheduleIntervalMs) || input.scheduleIntervalMs <= 0) {
        throw new Error("scheduleIntervalMs is required and must be > 0 for scheduleType='interval'");
      }
      return {
        type: "interval",
        intervalMs: input.scheduleIntervalMs,
      };
    }
    case "cron": {
      if (!input.scheduleCron || input.scheduleCron.trim().length === 0) {
        throw new Error("scheduleCron is required for scheduleType='cron'");
      }
      return {
        type: "cron",
        expression: input.scheduleCron,
      };
    }
  }
}

export async function buildCronSchemasAsync(): Promise<{
  addCronInputSchema: z.ZodObject<any>;
  editCronInputSchema: z.ZodObject<any>;
  editCronInstructionsInputSchema: z.ZodObject<any>;
}> {
  const staticToolSchema = z.enum(CRON_VALID_TOOL_NAMES);

  const dynamicToolNameSchema: z.ZodUnion<any> = z.union([
    staticToolSchema,
    z.string().regex(/^write_table_.+$/),
    z.string().regex(/^update_table_.+$/),
  ]);

  const toolsArraySchema: z.ZodArray<any> = dynamicToolNameSchema.array().min(1);

  const logger: LoggerService = LoggerService.getInstance();
  logger.debug("[buildCronTools] Built dynamic tools schema for cron tools");

  const toolsFieldDescription: string = `Valid tools include: ${CRON_VALID_TOOL_NAMES.join(", ")}, write_table_<tableName>, update_table_<tableName>. send_message performs internal deduplication against previous cron messages.`;

  const addCronInputSchema: z.ZodObject<any> = (addCronToolInputSchema._def as any).schema.extend({
    tools: toolsArraySchema.describe(`Tool names available to the task agent (required, at least one). ${toolsFieldDescription}`),
  });

  const editCronInputSchema: z.ZodObject<any> = editCronToolInputSchema.extend({
    tools: toolsArraySchema.optional().describe(`Updated list of available tool names. ${toolsFieldDescription}`),
  });

  const editCronInstructionsInputSchema: z.ZodObject<any> = editCronInstructionsToolInputSchema.extend({
    tools: toolsArraySchema.optional().describe(`Optional replacement tool list to apply together with the instruction update. ${toolsFieldDescription}`),
  });

  return {
    addCronInputSchema,
    editCronInputSchema,
    editCronInstructionsInputSchema,
  };
}

//#endregion Private Helper Functions

//#region Execute Functions

const executeAddCron = async ({
  name,
  description,
  instructions,
  tools,
  scheduleType,
  scheduleRunAt,
  scheduleIntervalMs,
  scheduleCron,
  notifyUser,
}: {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  scheduleType: "once" | "interval" | "cron";
  scheduleRunAt?: string;
  scheduleIntervalMs?: number;
  scheduleCron?: string;
  notifyUser: boolean;
}): Promise<IAddCronResult> => {
  const logger: LoggerService = LoggerService.getInstance();

  try {
    logger.debug(`[add-cron] Verifying cron instructions for: ${name}`);

    const toolContextBlock: string = await buildCronToolContextBlockAsync(tools);

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
      const errorMsg = `CRON REJECTED. The instructions are ambiguous or missing context: ${verificationResult.object.missingContext}. Please provide complete, self-contained instructions.`;
      logger.warn(`[add-cron] Cron rejected: ${errorMsg}`);
      return { taskId: "", success: false, error: errorMsg };
    }

    const taskId: string = generateId();
    const now: string = new Date().toISOString();
    const builtSchedule: Schedule = buildSchedule({ scheduleType, scheduleRunAt, scheduleIntervalMs, scheduleCron });

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
    logger.error(`[add-cron] Failed to add cron task: ${errorMessage}`);

    return { taskId: "", success: false, error: errorMessage };
  }
};

const executeEditCron = async ({
  taskId,
  name,
  description,
  tools,
  scheduleType,
  scheduleRunAt,
  scheduleIntervalMs,
  scheduleCron,
  notifyUser,
  enabled,
}: {
  taskId: string;
  name?: string;
  description?: string;
  tools?: string[];
  scheduleType?: "once" | "interval" | "cron";
  scheduleRunAt?: string;
  scheduleIntervalMs?: number;
  scheduleCron?: string;
  notifyUser?: boolean;
  enabled?: boolean;
}): Promise<IEditCronResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();

  try {
    const existingTask = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Cron task with ID '${taskId}' not found.` };
    }

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (tools !== undefined) patch.tools = tools;
    if (notifyUser !== undefined) patch.notifyUser = notifyUser;
    if (enabled !== undefined) patch.enabled = enabled;

    if (scheduleType !== undefined) {
      if (scheduleType !== existingTask.schedule.type) {
        logger.debug(`[edit_cron] Ignoring scheduleType change request`, {
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

      patch.schedule = schedule;
    } else if (scheduleRunAt !== undefined || scheduleIntervalMs !== undefined || scheduleCron !== undefined) {
      const schedule: Record<string, unknown> = { type: existingTask.schedule.type };

      if (existingTask.schedule.type === "once") {
        schedule.runAt = scheduleRunAt !== undefined ? scheduleRunAt : existingTask.schedule.runAt;
      } else if (existingTask.schedule.type === "interval") {
        schedule.intervalMs = scheduleIntervalMs !== undefined ? scheduleIntervalMs : existingTask.schedule.intervalMs;
      } else {
        schedule.expression = scheduleCron !== undefined ? scheduleCron : existingTask.schedule.expression;
      }

      patch.schedule = schedule;
    }

    if (Object.keys(patch).length === 0) {
      return {
        success: false,
        error:
          "No editable fields were provided. Use edit_cron for name/description/tools/schedule/notifyUser/enabled. " +
          "To change instructions, use edit_cron_instructions with the COMPLETE new instructions text and intention.",
      };
    }

    const updatedTask = await scheduler.updateTaskAsync(taskId, patch as any);

    if (updatedTask) {
      logger.info("[edit_cron] Updated task details", {
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
    logger.error(`[edit_cron] Failed to edit cron task: ${errorMessage}`, {
      taskId,
      patch: { name, description, tools, scheduleType, scheduleRunAt, scheduleIntervalMs, scheduleCron, notifyUser, enabled },
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

const executeEditCronInstructions = async ({
  taskId,
  instructions,
  intention,
  tools,
}: {
  taskId: string;
  instructions: string;
  intention: string;
  tools?: string[];
}): Promise<IEditCronInstructionsResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();

  try {
    const existingTask: IScheduledTask | undefined = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Cron task with ID '${taskId}' not found.` };
    }

    const normalizedInstructions: string = (instructions ?? "").trim();
    if (normalizedInstructions.length === 0) {
      return {
        success: false,
        error: "instructions is required. Provide the complete new instructions text.",
      };
    }

    const normalizedIntention: string = (intention ?? "").trim();
    if (normalizedIntention.length === 0) {
      return {
        success: false,
        error: "intention is required. Explain why this instruction update is needed.",
      };
    }

    const instructionsActuallyChanged: boolean =
      normalizedInstructions !== existingTask.instructions.trim();

    if (!instructionsActuallyChanged) {
      return {
        success: false,
        error: "No instruction change detected. Provide updated complete instructions text in the 'instructions' field.",
      };
    }

    logger.debug(`[edit_cron_instructions] Re-verifying cron instructions for task: ${taskId}`);

    const toolsToVerify: string[] = tools ?? existingTask.tools;
    const toolContextBlock: string = await buildCronToolContextBlockAsync(toolsToVerify);

    const lowerInstructions: string = normalizedInstructions.toLowerCase();
    const mentionsRunCmd: boolean = lowerInstructions.includes("run_cmd");
    const mentionsSqlite: boolean = lowerInstructions.includes("sqlite") || lowerInstructions.includes("sqlite3");
    if (mentionsRunCmd && mentionsSqlite) {
      const recommendedWriter: string | undefined = toolsToVerify.find((toolName: string) => toolName.startsWith("write_table_"));
      const guidance: string = recommendedWriter
        ? `Use ${recommendedWriter} for inserts and database tools (read_from_database/update_database/delete_from_database) for mutations instead of run_cmd/sqlite3.`
        : "Use write_table_<tableName> for inserts and database tools (read_from_database/update_database/delete_from_database) instead of run_cmd/sqlite3.";

      return {
        success: false,
        error: `EDIT REJECTED. Instructions must not use run_cmd with sqlite/sqlite3 for internal database work. ${guidance}`,
      };
    }

    const verifierPrompt: string = `
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

7. Database rules are strict:
   - NEVER use run_cmd with sqlite/sqlite3 for internal database work.
   - For inserts, prefer write_table_<tableName> tools when available.
   - Use read_from_database/update_database/delete_from_database for database access and mutation.
   - Use just database names without .db extension.

8. If instructions mention tools not present in the tool list, they are invalid unless those tools are being added in this same update.

=== CURRENT CRON TASK ===
Task ID: ${existingTask.taskId}
Name: ${existingTask.name}
Description: ${existingTask.description}
Schedule: ${JSON.stringify(existingTask.schedule)}
Tools: ${existingTask.tools.join(", ")}
notifyUser: ${existingTask.notifyUser}
Enabled: ${existingTask.enabled}

Current Instructions:
"""
${existingTask.instructions}
"""

=== PROPOSED NEW INSTRUCTIONS ===
"""
${normalizedInstructions}
"""

=== PROPOSED TOOLS ===
${toolsToVerify.join(", ")}

=== CHANGE INTENTION ===
${normalizedIntention}

Output a JSON object with:
- "isClear": boolean (true if valid, false if invalid)
- "missingContext": string (if invalid, describe exactly what information is missing and why it cannot be derived; if valid, use empty string)
`;

    const aiService: AiProviderService = AiProviderService.getInstance();
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
        `Current instructions:\n${existingTask.instructions}\n\n` +
        `Proposed instructions:\n${normalizedInstructions}\n\n` +
        `Intention: ${normalizedIntention}`;

      logger.warn(`[edit_cron_instructions] Edit rejected`, {
        taskId,
        reason: verificationResult.object.missingContext,
      });

      return { success: false, error: errorMsg };
    }

    const updatePatch: { instructions: string; tools?: string[] } = {
      instructions: normalizedInstructions,
    };
    if (tools !== undefined) {
      updatePatch.tools = tools;
    }

    const updatedTask: IScheduledTask | undefined = await scheduler.updateTaskAsync(taskId, updatePatch);

    if (updatedTask) {
      logger.info("[edit_cron_instructions] Updated task instructions", {
        taskId: updatedTask.taskId,
        name: updatedTask.name,
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
    logger.error(`[edit_cron_instructions] Failed to edit cron instructions: ${errorMessage}`, {
      taskId,
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

//#endregion Execute Functions

//#region Public Functions

export async function buildCronToolsAsync(): Promise<ICronTools> {
  const {
    addCronInputSchema,
    editCronInputSchema,
    editCronInstructionsInputSchema,
  } = await buildCronSchemasAsync();

  const addCronToolInstance = tool({
    description: ADD_CRON_DESCRIPTION,
    inputSchema: addCronInputSchema as any,
    execute: executeAddCron,
  });

  const editCronToolInstance = tool({
    description: EDIT_CRON_DESCRIPTION,
    inputSchema: editCronInputSchema as any,
    execute: executeEditCron,
  });

  const editCronInstructionsToolInstance = tool({
    description: EDIT_CRON_INSTRUCTIONS_DESCRIPTION,
    inputSchema: editCronInstructionsInputSchema as any,
    execute: executeEditCronInstructions,
  });

  return {
    add_cron: addCronToolInstance,
    edit_cron: editCronToolInstance,
    edit_cron_instructions: editCronInstructionsToolInstance,
  };
}

//#endregion Public Functions
