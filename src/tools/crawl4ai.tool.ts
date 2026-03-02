import { tool } from "ai";
import { crawl4aiToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { crawlUrlAsync } from "../utils/crawl4ai-client.js";
import { extractErrorMessage } from "../utils/error.js";

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

export const crawl4aiTool = tool({
  description:
    "Fetch and parse a web page using Crawl4AI. Returns the page content in markdown format for easy reading. " +
    "Use selector to extract specific content with CSS selectors.",
  inputSchema: crawl4aiToolInputSchema,
  execute: async ({
    url,
    selector,
  }: {
    url: string;
    selector?: string;
  }): Promise<{ content: string; error?: string }> => {
    try {
      const crawlResult = await crawlUrlAsync(url, {
        selector,
        cacheMode: "bypass",
      });

      const formattedMarkdown: string = formatCrawlResultAsMarkdown(
        crawlResult.url,
        crawlResult.success,
        crawlResult.markdown,
      );

      return { content: formattedMarkdown };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      return { content: "", error: `Crawl4AI crawl failed: ${errorMessage}` };
    }
  },
});
