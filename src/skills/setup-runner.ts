import { ToolLoopAgent, ToolSet, stepCountIs, LanguageModel, Tool } from "ai";
import { ISkill } from "../shared/types/index.js";
import { PROMPT_SKILL_SETUP } from "../shared/constants.js";
import { PromptService } from "../services/prompt.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import * as skillState from "../helpers/skill-state.js";
import { LoggerService } from "../services/logger.service.js";
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { wrapToolSetWithReasoning } from "../utils/tool-reasoning-wrapper.js";
import { thinkTool, runCmdTool } from "../tools/index.js";

//#region Interfaces

export interface ISetupResult {
  success: boolean;
  summary: string;
  error: string | null;
}

//#endregion Interfaces

//#region Public functions

export async function runSkillSetupAsync(skill: ISkill): Promise<ISetupResult> {
  const logger: LoggerService = LoggerService.getInstance();

  try {
    const setupPrompt: string = await PromptService.getInstance().getPromptAsync(PROMPT_SKILL_SETUP);

    const requirements = skill.frontmatter.metadata.openclaw;

    const context: string = [
      `Skill Name: ${skill.name}`,
      `Instructions: ${skill.instructions}`,
      `Requirements: ${JSON.stringify(requirements)}`,
    ].join("\n");

    const model: LanguageModel = AiProviderService.getInstance().getModel();

    const tools: ToolSet = {
      think: thinkTool as unknown as Tool,
      run_cmd: runCmdTool as unknown as Tool,
    };

    const wrappedTools: ToolSet = wrapToolSetWithReasoning(tools, {
      logger,
    });

    const agent: ToolLoopAgent = new ToolLoopAgent({
      model,
      instructions: `${setupPrompt}\n\n${context}`,
      tools: wrappedTools,
      stopWhen: [stepCountIs(10)],
      experimental_repairToolCall: repairToolCallJsonAsync,
    });

    const result = await agent.generate({
      prompt: "Set up this skill according to the instructions.",
    });

    await skillState.markSkillSetupCompleteAsync(skill.name);

    return {
      success: true,
      summary: result.text,
      error: null,
    };
  } catch (err: unknown) {
    const errorMessage: string = err instanceof Error ? err.message : String(err);

    logger.error(`Skill setup failed for "${skill.name}": ${errorMessage}`);

    await skillState.markSkillSetupErrorAsync(skill.name, errorMessage);

    return {
      success: false,
      summary: "",
      error: errorMessage,
    };
  }
}

//#endregion Public functions
