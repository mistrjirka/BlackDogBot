import { tool } from "langchain";
import { z } from "zod";
import { addCronToolInputSchema, CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";
import { validateCronToolNames, buildSchedule } from "../helpers/cron-validation.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { ConfigService } from "../services/config.service.js";
import { createChatModel } from "../services/langchain-model.service.js";
import { generateId } from "../utils/id.js";
import { extractErrorMessage } from "../utils/error.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

interface IAddCronResult {
  taskId: string;
  success: boolean;
  error?: string;
}

interface IInstructionVerificationResult {
  isClear: boolean;
  missingContext: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "add-cron";
const TOOL_DESCRIPTION: string =
  "Add a new scheduled task (cron job) to the scheduler. " +
  "Required inputs: name, description, instructions, tools, scheduleType, notifyUser. " +
  "send_message performs internal deduplication against previous cron messages. " +
  "Schedule-specific required input: scheduleRunAt for scheduleType='once', scheduleIntervalMs for scheduleType='interval', scheduleCron for scheduleType='cron'. " +
  "Examples: once => scheduleRunAt='2026-03-20T08:00:00Z'; interval => scheduleIntervalMs=7200000; cron => scheduleCron='0 */2 * * *'. " +
  "If the task's instructions reference a database, ensure the database and table(s) have been created first using create_database and create_table, then reference them by name (without .db extension) in the instructions.";

const instructionVerificationResultSchema = z.object({
  isClear: z.boolean(),
  missingContext: z.string(),
});

//#endregion Const

//#region Private methods

function _extractTextFromAiContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((part): part is { type: string; text?: unknown } => typeof part === "object" && part !== null)
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text);

    return textParts.join("\n").trim();
  }

  return "";
}

function _extractTextFromReasoningContent(additionalKwargs: unknown): string {
  if (typeof additionalKwargs !== "object" || additionalKwargs === null) {
    return "";
  }

  const rawReasoning = (additionalKwargs as { reasoning_content?: unknown }).reasoning_content;
  if (typeof rawReasoning === "string") {
    return rawReasoning;
  }

  return "";
}

function _parseVerificationResultOrThrow(rawText: string): IInstructionVerificationResult {
  const trimmed = rawText.trim();

  const parseWithSchema = (candidate: string): IInstructionVerificationResult | null => {
    try {
      const parsedJson = JSON.parse(candidate) as unknown;
      const parsed = instructionVerificationResultSchema.safeParse(parsedJson);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const candidates: string[] = [
    trimmed,
    ..._extractTopLevelJsonObjectCandidates(trimmed),
  ];

  for (const candidate of candidates) {
    const parsed = parseWithSchema(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new Error(`Verifier returned invalid structured response: ${trimmed.slice(0, 200)}`);
}

function _extractTopLevelJsonObjectCandidates(rawText: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objectStart = -1;

  for (let i = 0; i < rawText.length; i++) {
    const char = rawText[i];

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

async function _verifyInstructionsAsync(instructions: string, tools: string[], logger: LoggerService): Promise<IInstructionVerificationResult> {
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

  const model = createChatModel(ConfigService.getInstance().getAiConfig());
  const response = await model.invoke(verifierPrompt);
  const rawText: string = _extractTextFromAiContent(response.content);
  const rawReasoningText: string = _extractTextFromReasoningContent(
    (response as { additional_kwargs?: unknown }).additional_kwargs,
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

  return _parseVerificationResultOrThrow(mergedRawText);
}

//#endregion Private methods

//#region Tool

export const addCronTool = tool(
  async ({
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
      // 0. Validate tool names at runtime
      const invalidTools: string[] = validateCronToolNames(tools);
      if (invalidTools.length > 0) {
        return {
          taskId: "",
          success: false,
          error: `Invalid tool name(s): ${invalidTools.join(", ")}. Valid tools: ${CRON_VALID_TOOL_NAMES.join(", ")}`,
        };
      }

      // 1. Verify instructions using LLM
      logger.debug(`[${TOOL_NAME}] Verifying cron instructions for: ${name}`);

      const verificationResult: IInstructionVerificationResult = await _verifyInstructionsAsync(instructions, tools, logger);

      if (!verificationResult.isClear) {
        const errorMsg = `CRON REJECTED. The instructions are ambiguous or missing context: ${verificationResult.missingContext}. Please provide complete, self-contained instructions.`;
        logger.warn(`[${TOOL_NAME}] Cron rejected: ${errorMsg}`);
        return { taskId: "", success: false, error: errorMsg };
      }

      // 2. Schedule the task
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
      logger.error(`[${TOOL_NAME}] Failed to add cron task: ${errorMessage}`);

      return { taskId: "", success: false, error: errorMessage };
    }
  },
  {
    name: "add_cron",
    description: TOOL_DESCRIPTION,
    schema: addCronToolInputSchema,
  },
);

//#endregion Tool
