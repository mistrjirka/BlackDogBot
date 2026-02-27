import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { fetchWithTimeout } from "./fetch-with-timeout.js";

const DEFAULT_TIMEOUT_MS = 30000;

export interface ISearxngClientOptions {
  categories?: string[];
  maxResults?: number;
  safesearch?: number;
  language?: string;
}

export interface ISearxngResult {
  title?: string;
  url?: string;
  content?: string;
  img_src?: string;
  thumbnail?: string;
}

export interface ISearxngClientResponse {
  query: string;
  number_of_results: number;
  results: ISearxngResult[];
}

export async function searchSearxngAsync(
  query: string,
  options?: ISearxngClientOptions,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ISearxngClientResponse> {
  const logger: LoggerService = LoggerService.getInstance();
  const configService: ConfigService = ConfigService.getInstance();
  const searxngUrl: string | undefined = configService.getConfig().services?.searxngUrl;

  if (!searxngUrl) {
    throw new Error("SearXNG is not configured. Set services.searxngUrl in config.");
  }

  const params: URLSearchParams = new URLSearchParams();
  params.set("q", query);
  params.set("format", "json");

  if (options?.categories && options.categories.length > 0) {
    params.set("categories", options.categories.join(","));
  }

  if (options?.maxResults && options.maxResults > 0) {
    params.set("max_results", String(options.maxResults));
  }

  if (options?.safesearch !== undefined) {
    params.set("safesearch", String(options.safesearch));
  }

  if (options?.language) {
    params.set("language", options.language);
  }

  const url: string = `${searxngUrl}/search?${params.toString()}`;
  logger.debug("SearXNG search", { query, url });

  const response: Response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { "Accept": "application/json" },
    },
    timeoutMs,
  );

  if (!response.ok) {
    const errorText: string = await response.text();
    throw new Error(`SearXNG request failed (${response.status}): ${errorText}`);
  }

  const searchResult: ISearxngClientResponse = await response.json() as ISearxngClientResponse;
  return searchResult;
}
