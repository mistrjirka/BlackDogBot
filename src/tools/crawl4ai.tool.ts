import { tool } from "ai";
import { crawl4aiToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { crawlUrlAsync } from "../utils/crawl4ai-client.js";
import { extractErrorMessage } from "../utils/error.js";
import { LoggerService } from "../services/logger.service.js";
import { StartupDiagnosticsService } from "../services/startup-diagnostics.service.js";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

function formatCrawlResultAsMarkdown(
  url: string,
  success: boolean,
  markdown: string,
): string {
  let md = `## Crawl Result for "${url}"\n\n`;

  if (!success) {
    md += "**Status:** Failed\n\n";
    return md;
  }

  md += "**Status:** Success\n\n";

  if (markdown) {
    md += "### Content\n\n";
    const truncated = markdown.length > 5000 ? markdown.slice(0, 5000) + "\n\n_(truncated)_" : markdown;
    md += truncated;
  } else {
    md += "_No content retrieved_";
  }

  return md;
}

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const crawl4aiTool = tool({
  description:
    "Fetch and parse a web page using Crawl4AI. Returns the page content in markdown format for easy reading. " +
    "Use selector to extract specific content with CSS selectors. " +
    "Automatically retries on failure and falls back to alternative methods if unavailable.",
  inputSchema: crawl4aiToolInputSchema,
  execute: async ({
    url,
    selector,
  }: {
    url: string;
    selector?: string;
  }): Promise<{ content: string; error?: string }> => {
    const logger = LoggerService.getInstance();
    const diagnostics = StartupDiagnosticsService.getInstance();

    // Check if service is known to be unhealthy
    if (diagnostics.isServiceUnhealthy("Crawl4AI")) {
      logger.debug("Crawl4AI marked as unhealthy, skipping direct attempt");
      return {
        content: "",
        error:
          "Crawl4AI is currently unavailable. Use searxng for search, or use run_cmd with curl to fetch web pages directly.",
      };
    }

    let lastError: string = "";

    // Retry loop
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const crawlResult = await crawlUrlAsync(url, {
          selector,
          cacheMode: "bypass",
        });

        // Mark as healthy on success
        diagnostics.markServiceHealthy("Crawl4AI");

        const formattedMarkdown: string = formatCrawlResultAsMarkdown(
          crawlResult.url,
          crawlResult.success,
          crawlResult.markdown,
        );

        return { content: formattedMarkdown };
      } catch (error: unknown) {
        lastError = extractErrorMessage(error);

        if (attempt < MAX_RETRIES) {
          logger.warn(`Crawl4AI attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`, {
            url,
            error: lastError,
          });
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    // All retries failed - mark as unhealthy
    diagnostics.markServiceUnhealthy("Crawl4AI");

    return {
      content: "",
      error: `Crawl4AI crawl failed after ${MAX_RETRIES} attempts: ${lastError}. Use searxng for search or run_cmd with curl to fetch web pages directly.`,
    };
  },
});
