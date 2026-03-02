import { tool } from "ai";
import { searxngToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { searchSearxngAsync } from "../utils/searxng-client.js";
import { extractErrorMessage } from "../utils/error.js";

interface ISearxngResult {
  title?: string;
  url?: string;
  content?: string;
  img_src?: string;
  thumbnail?: string;
}

function formatResultsAsMarkdown(
  query: string,
  numberOfResults: number,
  results: ISearxngResult[],
): string {
  if (results.length === 0) {
    return `## Search Results for "${query}"\n\nNo results found.`;
  }

  let markdown = `## Search Results for "${query}"\n\n`;
  markdown += `Found ${numberOfResults} results. Showing ${results.length}:\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    markdown += `${i + 1}. **${r.title ?? "No title"}**\n`;
    if (r.url) {
      markdown += `   - URL: ${r.url}\n`;
    }
    if (r.content) {
      markdown += `   - ${r.content}\n`;
    }
    markdown += "\n";
  }

  return markdown;
}

export const searxngTool = tool({
  description:
    "Search the web using SearXNG. Returns search results formatted as markdown for easy reading. " +
    "Supports categories (general, news, images, videos, etc.) and safe search levels.",
  inputSchema: searxngToolInputSchema,
  execute: async ({
    query,
    categories,
    maxResults,
    safesearch,
    language,
  }: {
    query: string;
    categories?: string[];
    maxResults?: number;
    safesearch?: number;
    language?: string;
  }): Promise<{ results: string; error?: string }> => {
    try {
      const searchResult = await searchSearxngAsync(query, {
        categories,
        maxResults: maxResults ?? 10,
        safesearch,
        language,
      });

      const formattedMarkdown: string = formatResultsAsMarkdown(
        searchResult.query,
        searchResult.number_of_results,
        searchResult.results,
      );

      return { results: formattedMarkdown };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      return { results: "", error: `SearXNG search failed: ${errorMessage}` };
    }
  },
});
