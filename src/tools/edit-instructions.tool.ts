import { tool } from "ai";
import { z } from "zod";
import { editInstructionsToolInputSchema, TOOL_PREREQUISITES, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { filterInvalidTools } from "../utils/cron-tool-validation.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import { buildPerTableToolsAsync, buildUpdateTableToolsAsync } from "../utils/per-table-tools.js";
import { buildCronTaskVerifierPrompt } from "../utils/cron-task-verifier.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditInstructionsResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

//#endregion Interfaces

//#region Constants

const TOOL_NAME: string = "edit_instructions";
const TOOL_DESCRIPTION: string =
  "Update ONLY the instructions text of an existing scheduled task. " +
  "You MUST provide the COMPLETE new instructions text in the 'instructions' field (full replacement), plus 'intention' explaining why the change is needed. " +
  "Optionally provide 'tools' to replace the task tool list in the same call when instruction changes require different tools. " +
  "IMPORTANT: 'intention' is metadata only and does NOT change instructions by itself. " +
  "IMPORTANT: You MUST call 'get_timed' first to retrieve the current task configuration before using this tool.";

//#endregion Constants

//#region Tool

const executeEditInstructions = async (
  {
    taskId,
    instructions,
    intention,
    tools,
  }: {
    taskId: string;
    instructions: string;
    intention: string;
    tools?: string[];
  },
  _context: ToolExecuteContext,
): Promise<IEditInstructionsResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();
  const timezone: string | undefined = ConfigService.getInstance().getConfig().scheduler.timezone;

  try {
    const existingTask: IScheduledTask | undefined = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Task with ID '${taskId}' not found.` };
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

    if (tools !== undefined) {
      const invalidTools: string[] = filterInvalidTools(tools);
      if (invalidTools.length > 0) {
        return {
          success: false,
          error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}`,
        };
      }
    }

    const instructionsActuallyChanged: boolean =
      normalizedInstructions !== existingTask.instructions.trim();

    if (!instructionsActuallyChanged) {
      return {
        success: false,
        error: "No instruction change detected. Provide updated complete instructions text in the 'instructions' field.",
      };
    }

    logger.debug(`[${TOOL_NAME}] Re-verifying instructions for task: ${taskId}`);

    const toolsToVerify: string[] = tools ?? existingTask.tools;

    const [writeResult, updateResult] = await Promise.all([
      buildPerTableToolsAsync(),
      buildUpdateTableToolsAsync(),
    ]);
    const allDynamicTableTools: string[] = [
      ...Object.keys(writeResult.tools),
      ...Object.keys(updateResult.tools),
    ];
    const expandedToolsToVerify: string[] = [...new Set([...toolsToVerify, ...allDynamicTableTools])];

   const toolContextBlock: string = await buildCronToolContextBlockAsync(expandedToolsToVerify);

    const lowerInstructions: string = normalizedInstructions.toLowerCase();
    const mentionsRunCmd: boolean = lowerInstructions.includes("run_cmd");
    const mentionsSqlite: boolean = lowerInstructions.includes("sqlite") || lowerInstructions.includes("sqlite3");
    if (mentionsRunCmd && mentionsSqlite) {
      const recommendedWriter: string | undefined = toolsToVerify.find((toolName: string) => toolName.startsWith("write_table_"));
      const guidance: string = recommendedWriter
        ? `Use ${recommendedWriter} for inserts and table tools (read_from_database/update_table_<tableName>/delete_from_database) for mutations.`
        : "Use write_table_<tableName> for inserts and table tools (read_from_database/update_table_<tableName>/delete_from_database).";

      return {
        success: false,
        error: `EDIT REJECTED. Instructions must not use shell commands for internal database work. ${guidance}`,
      };
    }

    const verifierPrompt: string = buildCronTaskVerifierPrompt({
      instructions: normalizedInstructions,
      toolContextBlock,
      taskType: "edit",
      existingTask,
      proposedTools: toolsToVerify,
      intention: normalizedIntention,
    });

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

      logger.warn(`[${TOOL_NAME}] Edit rejected`, {
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
      logger.info("[edit_instructions] Updated task instructions", {
        taskId: updatedTask.taskId,
        name: updatedTask.name,
        updatedAt: updatedTask.updatedAt,
      });
    }

    return {
      success: true,
      task: updatedTask,
      display: updatedTask ? formatScheduledTask(updatedTask, timezone) : undefined,
    };
  } catch (error: unknown) {
    const errorMessage: string = extractErrorMessage(error);
    logger.error(`[${TOOL_NAME}] Failed to edit instructions: ${errorMessage}`, {
      taskId,
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

export const editInstructionsTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: editInstructionsToolInputSchema,
  execute: createToolWithPrerequisites(
    "edit_instructions",
    TOOL_PREREQUISITES["edit_instructions"] || [],
    executeEditInstructions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK tool execute typing mismatch with wrapper
  ) as any,
});

//#endregion Tool
