import { ToolLoopAgent, ToolSet, hasToolCall, stepCountIs, LanguageModel } from "ai";
import { ISkill } from "../shared/types/index.js";
import { PROMPT_SKILL_SETUP } from "../shared/constants.js";
import { PromptService } from "../services/prompt.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { SkillStateService } from "../services/skill-state.service.js";
import { LoggerService } from "../services/logger.service.js";
import { thinkTool, doneTool, runCmdTool } from "../tools/index.js";

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
      think: thinkTool,
      done: doneTool,
      run_cmd: runCmdTool,
    };

    const agent: ToolLoopAgent = new ToolLoopAgent({
      model,
      instructions: `${setupPrompt}\n\n${context}`,
      tools,
      stopWhen: [hasToolCall("done"), stepCountIs(10)],
    });

    const result = await agent.generate({
      prompt: "Set up this skill according to the instructions.",
    });

    await SkillStateService.getInstance().markSetupCompleteAsync(skill.name);

    return {
      success: true,
      summary: result.text,
      error: null,
    };
  } catch (err: unknown) {
    const errorMessage: string = err instanceof Error ? err.message : String(err);

    logger.error(`Skill setup failed for "${skill.name}": ${errorMessage}`);

    await SkillStateService.getInstance().markSetupErrorAsync(skill.name, errorMessage);

    return {
      success: false,
      summary: "",
      error: errorMessage,
    };
  }
}

//#endregion Public functions
