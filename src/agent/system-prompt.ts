import { PromptService } from "../services/prompt.service.js";
import { ConfigService } from "../services/config.service.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { StartupDiagnosticsService } from "../services/startup-diagnostics.service.js";
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

  // Web search and crawling capability - now with runtime health awareness
  const searxngUrl: string | undefined = config.services?.searxngUrl;
  const crawl4aiUrl: string | undefined = config.services?.crawl4aiUrl;
  const diagnostics = StartupDiagnosticsService.getInstance();
  const searxngHealthy = searxngUrl && !diagnostics.isServiceUnhealthy("SearXNG");
  const crawl4aiHealthy = crawl4aiUrl && !diagnostics.isServiceUnhealthy("Crawl4AI");

  if (searxngUrl && crawl4aiUrl) {
    if (searxngHealthy && crawl4aiHealthy) {
      contextParts.push(
        `Web search and scraping: use the searxng tool for search and the crawl4ai tool for page fetching. ` +
        `Do NOT use run_cmd, curl, wget, or call_skill for web research. ` +
        `Configured services: SearXNG (${searxngUrl}), Crawl4AI (${crawl4aiUrl}).`,
      );
    } else if (searxngHealthy && !crawl4aiHealthy) {
      contextParts.push(
        `SearXNG is available at ${searxngUrl} for web search. ` +
        `Crawl4AI is currently unavailable. For page fetching, use run_cmd with curl: ` +
        `curl -sL -A "Mozilla/5.0" "URL" to fetch web content. ` +
        `Do NOT attempt to use crawl4ai tool while it is down.`,
      );
    } else if (!searxngHealthy && crawl4aiHealthy) {
      contextParts.push(
        `Crawl4AI is available at ${crawl4aiUrl} for page fetching. ` +
        `SearXNG is currently unavailable for web search. ` +
        `You can use crawl4ai to fetch pages, but web search is limited.`,
      );
    } else {
      contextParts.push(
        `Both SearXNG and Crawl4AI are currently unavailable. ` +
        `For web content, use run_cmd with curl: curl -sL -A "Mozilla/5.0" "URL". ` +
        `Web search capabilities are limited until services recover.`,
      );
    }
  } else if (!searxngUrl && !crawl4aiUrl) {
    contextParts.push(
      `Web search and scraping tools are unavailable because both SearXNG and Crawl4AI are not configured. ` +
      `If the user asks for web research, explain that services.searxngUrl and services.crawl4aiUrl must be configured.`,
    );
  } else if (!searxngUrl) {
    if (crawl4aiHealthy) {
      contextParts.push(
        `Crawl4AI is configured at ${crawl4aiUrl} for page fetching. ` +
        `SearXNG is not configured, so web search is not available. ` +
        `Use run_cmd with curl for basic HTTP requests.`,
      );
    } else {
      contextParts.push(
        `Crawl4AI is configured but currently unavailable. ` +
        `SearXNG is not configured. ` +
        `Use run_cmd with curl to fetch web content: curl -sL -A "Mozilla/5.0" "URL".`,
      );
    }
  } else {
    if (searxngHealthy) {
      contextParts.push(
        `SearXNG is configured at ${searxngUrl} for web search. ` +
        `Crawl4AI is not configured for page fetching. ` +
        `Use run_cmd with curl to fetch web content: curl -sL -A "Mozilla/5.0" "URL".`,
      );
    } else {
      contextParts.push(
        `SearXNG is configured but currently unavailable. ` +
        `Crawl4AI is not configured. ` +
        `Use run_cmd with curl to fetch web content: curl -sL -A "Mozilla/5.0" "URL".`,
      );
    }
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
