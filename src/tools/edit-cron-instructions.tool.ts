import { tool } from "langchain";
import { z } from "zod";

import { editCronInstructionsToolInputSchema, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { ConfigService } from "../services/config.service.js";
import { createChatModel } from "../services/langchain-model.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { formatScheduledTask } from "../utils/cron-format.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditCronInstructionsResult {
  success: boolean;
  task?: IScheduledTask;
  display?: string;
  error?: string;
}

interface IInstructionVerificationResult {
  isClear: boolean;
  missingContext: string;
}

//#endregion Interfaces

//#region Constants

const TOOL_NAME: string = "edit-cron-instructions";
const TOOL_DESCRIPTION: string =
  "Update ONLY the instructions text of an existing cron task. " +
  "You MUST provide the COMPLETE new instructions text in the 'instructions' field (full replacement), plus 'intention' explaining why the change is needed. " +
  "Optionally provide 'tools' to replace the task tool list in the same call when instruction changes require different tools. " +
  "IMPORTANT: 'intention' is metadata only and does NOT change instructions by itself. " +
  "IMPORTANT: You MUST call 'get_cron' first to retrieve the current task configuration before using this tool.";

const instructionVerificationResultSchema = z.object({
  isClear: z.boolean(),
  missingContext: z.string(),
});

//#endregion Constants

//#region Helper methods

function _extractTextFromAiContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = content
      .filter((part: unknown): part is { type: string; text?: unknown } => typeof part === "object" && part !== null)
      .filter((part: { type: string; text?: unknown }): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part: { type: "text"; text: string }) => part.text);

    return textParts.join("\n").trim();
  }

  return "";
}

function _extractTextFromReasoningContent(additionalKwargs: unknown): string {
  if (typeof additionalKwargs !== "object" || additionalKwargs === null) {
    return "";
  }

  const rawReasoning: unknown = (additionalKwargs as { reasoning_content?: unknown }).reasoning_content;
  if (typeof rawReasoning === "string") {
    return rawReasoning;
  }

  return "";
}

function _extractTopLevelJsonObjectCandidates(rawText: string): string[] {
  const candidates: string[] = [];
  let depth: number = 0;
  let inString: boolean = false;
  let escape: boolean = false;
  let objectStart: number = -1;

  for (let i: number = 0; i < rawText.length; i++) {
    const char: string = rawText[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\") {
        escape = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        objectStart = i;
      }

      depth++;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }

      depth--;
      if (depth === 0 && objectStart >= 0) {
        candidates.push(rawText.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }

  return candidates;
}

function _parseVerificationResultOrThrow(rawText: string): IInstructionVerificationResult {
  const trimmed: string = rawText.trim();

  const parseWithSchema = (candidate: string): IInstructionVerificationResult | null => {
    try {
      const parsedJson: unknown = JSON.parse(candidate);
      const parsed = instructionVerificationResultSchema.safeParse(parsedJson);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const candidates: string[] = [trimmed, ..._extractTopLevelJsonObjectCandidates(trimmed)];

  for (const candidate of candidates) {
    const parsed: IInstructionVerificationResult | null = parseWithSchema(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new Error(`Verifier returned invalid structured response: ${trimmed.slice(0, 200)}`);
}

//#endregion Helper methods

//#region Tool

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

    if (tools !== undefined) {
      const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
      const isDynamicWriteTableTool = (toolName: string): boolean => toolName.startsWith("write_table_");
      const invalidTools: string[] = tools.filter((t: string) => !validToolSet.has(t) && !isDynamicWriteTableTool(t));
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

    logger.debug(`[${TOOL_NAME}] Re-verifying cron instructions for task: ${taskId}`);

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

=== PROPOSED NEW INSTRUCTIONS
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

    const model = createChatModel(ConfigService.getInstance().getAiConfig());

    const verificationResponse = await model.invoke(verifierPrompt);
    const rawText: string = _extractTextFromAiContent(verificationResponse.content);
    const rawReasoningText: string = _extractTextFromReasoningContent(
      (verificationResponse as { additional_kwargs?: unknown }).additional_kwargs,
    );

    logger.debug(`[${TOOL_NAME}] Verifier raw response`, {
      contentPreview: rawText.slice(0, 200),
      reasoningPreview: rawReasoningText.slice(0, 200),
      contentLength: rawText.length,
      reasoningLength: rawReasoningText.length,
    });

    const mergedRawText: string = [rawText, rawReasoningText]
      .filter((value: string): boolean => value.trim().length > 0)
      .join("\n");

    const verificationResult: IInstructionVerificationResult = _parseVerificationResultOrThrow(mergedRawText);

    if (!verificationResult.isClear) {
      const errorMsg =
        `EDIT REJECTED. The updated instructions were not approved by the verifier.\n\n` +
        `Verifier reason: ${verificationResult.missingContext}\n\n` +
        `Current instructions:\n${existingTask.instructions}\n\n` +
        `Proposed instructions:\n${normalizedInstructions}\n\n` +
        `Intention: ${normalizedIntention}`;

      logger.warn(`[${TOOL_NAME}] Edit rejected`, {
        taskId,
        reason: verificationResult.missingContext,
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
      logger.info("[edit-cron-instructions] Updated task instructions", {
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
    logger.error(`[${TOOL_NAME}] Failed to edit cron instructions: ${errorMessage}`, {
      taskId,
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
};

export const editCronInstructionsTool = tool(
  executeEditCronInstructions,
  {
    name: "edit_cron_instructions",
    description: TOOL_DESCRIPTION,
    schema: editCronInstructionsToolInputSchema,
  },
);

//#endregion Tool
