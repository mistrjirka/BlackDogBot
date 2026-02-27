import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { fetchWithTimeout } from "./fetch-with-timeout.js";

const DEFAULT_TIMEOUT_MS = 30000;

export interface ICrawl4aiClientOptions {
  selector?: string;
  cacheMode?: string;
}

export interface ICrawl4aiClientResponse {
  url: string;
  markdown: string;
  html: string;
  success: boolean;
}

export async function crawlUrlAsync(
  url: string,
  options?: ICrawl4aiClientOptions,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ICrawl4aiClientResponse> {
  const logger: LoggerService = LoggerService.getInstance();
  const configService: ConfigService = ConfigService.getInstance();
  const crawl4aiUrl: string | undefined = configService.getConfig().services?.crawl4aiUrl;

  if (!crawl4aiUrl) {
    throw new Error("Crawl4AI is not configured. Set services.crawl4aiUrl in config.");
  }

  const crawlRequestBody: Record<string, unknown> = {
    urls: [url],
    crawler_config: {
      cache_mode: options?.cacheMode ?? "bypass",
    },
  };

  if (options?.selector) {
    (crawlRequestBody.crawler_config as Record<string, unknown>).css_selector = options.selector;
  }

  logger.debug("Crawl4AI request", { url, options });

  const response: Response = await fetchWithTimeout(
    `${crawl4aiUrl}/crawl`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(crawlRequestBody),
    },
    timeoutMs,
  );

  if (!response.ok) {
    const errorText: string = await response.text();
    throw new Error(`Crawl4AI request failed (${response.status}): ${errorText}`);
  }

  const crawlResult: Record<string, unknown> = await response.json() as Record<string, unknown>;
  const results: unknown[] = (crawlResult.results ?? []) as unknown[];
  const firstResult: Record<string, unknown> = (results[0] ?? {}) as Record<string, unknown>;

  const markdownField: unknown = firstResult.markdown;
  let markdown: string;

  if (markdownField && typeof markdownField === "object" && (markdownField as Record<string, unknown>).raw_markdown) {
    markdown = (markdownField as Record<string, unknown>).raw_markdown as string;
  } else if (typeof markdownField === "string") {
    markdown = markdownField;
  } else {
    markdown = "";
  }

  const html: string = typeof firstResult.html === "string" ? firstResult.html : "";
  const success: boolean = firstResult.success as boolean ?? false;

  return {
    url,
    markdown,
    html,
    success,
  };
}
