import { createDeepAgent } from "deepagents";
import { ISkill } from "../shared/types/index.js";
import { PROMPT_SKILL_SETUP } from "../shared/constants.js";
import { PromptService } from "../services/prompt.service.js";
import { ConfigService } from "../services/config.service.js";
import { createChatModel } from "../services/langchain-model.service.js";
import * as skillState from "../helpers/skill-state.js";
import { LoggerService } from "../services/logger.service.js";
import { thinkTool, runCmdTool } from "../tools/index.js";

export interface ISetupResult {
  success: boolean;
  summary: string;
  error: string | null;
}

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

    const subagent = createDeepAgent({
      model: createChatModel(ConfigService.getInstance().getAiConfig()),
      systemPrompt: `${setupPrompt}\n\n${context}`,
      tools: [thinkTool, runCmdTool],
    });

    const result = await subagent.invoke({
      messages: [{ role: "user", content: "Set up this skill according to the instructions." }],
    });

    await skillState.markSkillSetupCompleteAsync(skill.name);

    const lastMessage = result.messages[result.messages.length - 1];
    const summary: string = typeof lastMessage?.content === "string" ? lastMessage.content : "";

    return {
      success: true,
      summary,
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
