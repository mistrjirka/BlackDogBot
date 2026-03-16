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

  // Web search and crawling capability
  const searxngUrl: string | undefined = config.services?.searxngUrl;
  const crawl4aiUrl: string | undefined = config.services?.crawl4aiUrl;

  if (searxngUrl && crawl4aiUrl) {
    contextParts.push(
      `Web search and scraping: use the searxng tool for search and the crawl4ai tool for page fetching. ` +
      `Do NOT use run_cmd, curl, wget, or call_skill for web research. ` +
      `Configured services: SearXNG (${searxngUrl}), Crawl4AI (${crawl4aiUrl}).`,
    );
  } else if (!searxngUrl && !crawl4aiUrl) {
    contextParts.push(
      `Web search and scraping tools are unavailable because both SearXNG and Crawl4AI are not configured. ` +
      `If the user asks for web research, explain that services.searxngUrl and services.crawl4aiUrl must be configured.`,
    );
  } else if (!searxngUrl) {
    contextParts.push(
      `Web search via searxng is unavailable because SearXNG is not configured. ` +
      `Do not attempt web search with run_cmd/curl; explain that services.searxngUrl must be configured. ` +
      `Crawl4AI is configured at ${crawl4aiUrl}.`,
    );
  } else {
    contextParts.push(
      `Web page crawling via crawl4ai is unavailable because Crawl4AI is not configured. ` +
      `Use searxng for search only and explain that services.crawl4aiUrl must be configured for page fetching. ` +
      `SearXNG is configured at ${searxngUrl}.`,
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
