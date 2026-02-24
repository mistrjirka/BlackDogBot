import { tool } from "ai";
import { z } from "zod";
import { addCronToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateId } from "../utils/id.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";

//#region Interfaces

interface IAddCronResult {
  taskId: string;
  success: boolean;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "add-cron";
const TOOL_DESCRIPTION: string = "Add a new scheduled task (cron job) to the scheduler";

//#endregion Const

//#region Private methods

function _buildSchedule(input: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string }): Schedule {
  switch (input.type) {
    case "once":
      return {
        type: "once",
        runAt: input.runAt!,
      };
    case "interval":
      return {
        type: "interval",
        intervalMs: input.intervalMs!,
      };
    case "cron":
      return {
        type: "cron",
        expression: input.expression!,
      };
  }
}

//#endregion Private methods

//#region Tool

export const addCronTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: addCronToolInputSchema,
  execute: async ({
    name,
    description,
    instructions,
    tools,
    schedule,
  }: {
    name: string;
    description: string;
    instructions: string;
    tools: string[];
    schedule: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string };
  }): Promise<IAddCronResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      // 1. Verify instructions using LLM
      logger.debug(`[${TOOL_NAME}] Verifying cron instructions for: ${name}`);
      
      const verifierPrompt = `
You are a strict task instruction verifier for an autonomous AI agent.
The agent operates periodically based on predefined instructions. It has no memory of past conversations when it wakes up to run the task.
Your job is to read the provided instructions and determine if they contain ALL necessary context to act independently.

Specifically, instructions MUST explicitly include:
- Exact URLs, endpoints, feeds, or file paths (e.g. "http://10.8.0.9:8080/...")
- Exact rules, criteria, or constraints (e.g. "news that is interesting")
- Any specific times relative to execution (e.g. "news from the past hour", "at 8am and 6pm")
- Exact destinations to send results to (e.g. "send via Telegram", "save to database")

Instructions:
"""
${instructions}
"""

If the instructions rely on implicit context from a conversation (e.g. "fetch that feed", "do what we discussed", "between those times" without stating them), they are INVALID.
If the instructions are clear, specific, and self-contained, they are VALID.

Output a JSON object with:
- "isClear": boolean (true if valid, false if invalid)
- "missingContext": string (if invalid, detail exactly what information is missing. If valid, leave empty string)
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
        const errorMsg = `CRON REJECTED. The instructions are ambiguous or missing context: ${verificationResult.object.missingContext}. Please provide complete, self-contained instructions.`;
        logger.warn(`[${TOOL_NAME}] Cron rejected: ${errorMsg}`);
        return { taskId: "", success: false, error: errorMsg };
      }

      // 2. Schedule the task
      const taskId: string = generateId();
      const now: string = new Date().toISOString();
      const builtSchedule: Schedule = _buildSchedule(schedule);

      const task: IScheduledTask = {
        taskId,
        name,
        description,
        instructions,
        tools,
        schedule: builtSchedule,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
      };

      await SchedulerService.getInstance().addTaskAsync(task);

      return { taskId, success: true };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      logger.error(`[${TOOL_NAME}] Failed to add cron task: ${errorMessage}`);

      return { taskId: "", success: false, error: errorMessage };
    }
  },
});

//#endregion Tool
