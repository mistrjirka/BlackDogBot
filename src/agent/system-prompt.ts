import { PromptService } from "../services/prompt.service.js";
import { ConfigService } from "../services/config.service.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { PROMPT_MAIN_AGENT } from "../shared/constants.js";
import { getCurrentDateTime } from "../utils/time.js";

//#region Public functions

export async function buildMainAgentPromptAsync(): Promise<string> {
  const promptService: PromptService = PromptService.getInstance();
  const configService: ConfigService = ConfigService.getInstance();
  const config = configService.getConfig();

  let basePrompt: string = await promptService.getPromptAsync(PROMPT_MAIN_AGENT);

  if (!config.jobCreation.enabled) {
    basePrompt = basePrompt.replace(/<job_creation>[\s\S]*?<\/job_creation>\n?/g, "");
  }

  const dateString: string = getCurrentDateTime(config.scheduler?.timezone);

  // Build dynamic context about capabilities
  const contextParts: string[] = [`Current date and time: ${dateString}`];

  // Web search capability
  const searxngUrl: string | undefined = config.services?.searxngUrl;
  if (searxngUrl) {
    contextParts.push(
      `Web search: available via run_cmd. Example: curl '${searxngUrl}/search?q=QUERY&format=json&categories=general' ` +
      `— Do NOT use call_skill for web search. Use run_cmd with curl to SearXNG directly.`,
    );
  } else {
    contextParts.push(
      `Web search: SearXNG is not configured. You cannot perform web searches directly. ` +
      `If the user asks you to search the web, let them know SearXNG is not set up.`,
    );
  }

  // Skill availability
  const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
  if (availableSkills.length > 0) {
    const skillNames = availableSkills.map((s) => s.name).join(", ");
    contextParts.push(`Available skills: ${skillNames}. Only use call_skill with these exact names.`);
  } else {
    contextParts.push(
      `Skills: No skills are currently loaded. Do NOT attempt to use call_skill or get_skill_file — these tools are not available.`,
    );
  }

  const contextBlock: string = `\n\n<system_context>\n${contextParts.join("\n")}\n</system_context>`;

  return basePrompt + contextBlock;
}

//#endregion Public functions

