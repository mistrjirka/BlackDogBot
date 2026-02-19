import { PromptService } from "../services/prompt.service.js";
import { PROMPT_MAIN_AGENT } from "../shared/constants.js";

//#region Public functions

export async function buildMainAgentPromptAsync(): Promise<string> {
  const promptService: PromptService = PromptService.getInstance();
  const basePrompt: string = await promptService.getPromptAsync(PROMPT_MAIN_AGENT);
  const dateString: string = new Date().toISOString().split("T")[0];
  const contextBlock: string = `\n\n<system_context>\nCurrent date: ${dateString}\n</system_context>`;

  return basePrompt + contextBlock;
}

//#endregion Public functions
