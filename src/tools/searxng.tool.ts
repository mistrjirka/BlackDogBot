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
  numberOfResults: number | undefined,
  results: ISearxngResult[],
  unresponsiveEngines: Array<[string, string]> = [],
): string {
  const warning = unresponsiveEngines.length > 0
    ? `Search coverage incomplete (unresponsive engines: ${unresponsiveEngines.map(([name]) => name).join(", ")}).\n\n`
    : "";
  const header = `## Search Results for "${query}"\n\n${warning}`;
  if (results.length === 0) {
    return `${header}No results found in this search.`;
  }

  let markdown = header;
  markdown += typeof numberOfResults === "number" && Number.isFinite(numberOfResults) && numberOfResults > 0
    ? `Showing ${results.length} results (backend estimate: ${numberOfResults}).\n\n`
    : `Showing ${results.length} results; total index coverage is unknown.\n\n`;

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
    "Supports categories (general, news, images, videos, etc.) and safe search levels. " +
    "For better recall, keep queries short and specific (typically 2-5 words); avoid pasting full headlines or source domain names.",
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
        searchResult.unresponsive_engines,
      );

      return { results: formattedMarkdown };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      return { results: "", error: `SearXNG search failed: ${errorMessage}` };
    }
  },
});
