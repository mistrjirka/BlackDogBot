import { z } from "zod";
import type { IScheduledTask, Schedule } from "../shared/types/index.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { generateId } from "../utils/id.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import { buildCronToolContextBlockAsync } from "../utils/cron-tool-context.js";
import { buildCronTaskVerifierPrompt } from "../utils/cron-task-verifier.js";

export interface ICronInstructionVerificationOptions {
  taskType: "once" | "interval" | "edit";
  instructions: string;
  tools: string[];
  existingTask?: IScheduledTask;
  proposedTools?: string[];
  intention?: string;
}

export interface ICronInstructionVerificationResult {
  isClear: boolean;
  missingContext: string;
}

export interface IBuildTaskRecordOptions {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  schedule: Schedule;
  notifyUser: boolean;
  messageDedupEnabled?: boolean;
}

export async function verifyCronInstructionsAsync(
  options: ICronInstructionVerificationOptions,
): Promise<ICronInstructionVerificationResult> {
  const toolContextBlock: string = await buildCronToolContextBlockAsync(options.tools);
  const verifierPrompt: string = buildCronTaskVerifierPrompt({
    instructions: options.instructions,
    toolContextBlock,
    taskType: options.taskType,
    existingTask: options.existingTask,
    proposedTools: options.proposedTools,
    intention: options.intention,
    availableSkills: SkillLoaderService.getInstance().getAvailableSkills().map((skill) => skill.name),
  });
  const model = AiProviderService.getInstance().getModel();
  const verificationResult = await generateObjectWithRetryAsync({
    model,
    schema: z.object({
      isClear: z.boolean(),
      missingContext: z.string(),
    }),
    prompt: verifierPrompt,
    retryOptions: { callType: "schema_extraction" },
  });

  return verificationResult.object;
}

export function buildTaskRecord(options: IBuildTaskRecordOptions): IScheduledTask {
  const taskId: string = generateId();
  const now: string = new Date().toISOString();

  return {
    taskId,
    name: options.name,
    description: options.description,
    instructions: options.instructions,
    tools: options.tools,
    schedule: options.schedule,
    notifyUser: options.notifyUser,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    messageDedupEnabled: options.messageDedupEnabled ?? true,
  };
}
