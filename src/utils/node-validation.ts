import { ConfigService } from "../services/config.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "./error.js";

//#region Constants

const PROBE_TIMEOUT_MS: number = 15000;

//#endregion Constants

//#region Public functions

export async function probeUrlAsync(url: string, method: string = "HEAD"): Promise<{ reachable: boolean; error: string }> {
  const controller: AbortController = new AbortController();
  const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response: Response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { "User-Agent": "BlackDogBot/1.0" },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { reachable: false, error: `HTTP ${response.status} ${response.statusText}` };
    }

    return { reachable: true, error: "" };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const message: string = extractErrorMessage(err);

    if (message.includes("abort")) {
      return { reachable: false, error: `Request timed out after ${PROBE_TIMEOUT_MS}ms` };
    }

    return { reachable: false, error: message };
  }
}

export function hasTemplateVariables(value: string): boolean {
  return /\{\{.+?\}\}/.test(value);
}

export async function validateFetcherConfigAsync(
  type: string,
  config: Record<string, unknown>,
): Promise<{ valid: boolean; error: string }> {
  const logger: LoggerService = LoggerService.getInstance();

  if (type === "curl_fetcher") {
    const url: string = (config.url as string) ?? "";

    if (!url) {
      return { valid: false, error: "curl_fetcher config requires a 'url' field" };
    }

    if (hasTemplateVariables(url)) {
      return { valid: true, error: "" };
    }

    logger.debug("Probing curl_fetcher URL", { url });

    const method: string = (config.method as string) ?? "GET";
    const probe = await probeUrlAsync(url, method === "HEAD" ? "HEAD" : "HEAD");

    if (!probe.reachable) {
      // Retry with GET since some servers reject HEAD
      const retryProbe = await probeUrlAsync(url, "GET");

      if (!retryProbe.reachable) {
        return { valid: false, error: `URL "${url}" is not reachable: ${retryProbe.error}` };
      }
    }

    return { valid: true, error: "" };
  }

  if (type === "rss_fetcher") {
    const url: string = (config.url as string) ?? "";

    if (!url) {
      return { valid: false, error: "rss_fetcher config requires a 'url' field" };
    }

    if (hasTemplateVariables(url)) {
      return { valid: true, error: "" };
    }

    logger.debug("Probing rss_fetcher URL", { url });
    const probe = await probeUrlAsync(url, "GET");

    if (!probe.reachable) {
      return { valid: false, error: `RSS feed URL "${url}" is not reachable: ${probe.error}` };
    }

    return { valid: true, error: "" };
  }

  if (type === "crawl4ai") {
    const url: string = (config.url as string) ?? "";

    if (!url) {
      return { valid: false, error: "crawl4ai config requires a 'url' field" };
    }

    if (hasTemplateVariables(url)) {
      return { valid: true, error: "" };
    }

    logger.debug("Probing crawl4ai target URL", { url });
    const probe = await probeUrlAsync(url, "HEAD");

    if (!probe.reachable) {
      const retryProbe = await probeUrlAsync(url, "GET");

      if (!retryProbe.reachable) {
        return { valid: false, error: `Crawl target URL "${url}" is not reachable: ${retryProbe.error}` };
      }
    }

    // Also probe the Crawl4AI service itself
    try {
      const configService: ConfigService = ConfigService.getInstance();
      const crawl4aiUrl: string = configService.getConfig().services.crawl4aiUrl;

      const serviceProbe = await probeUrlAsync(`${crawl4aiUrl}/health`, "GET");

      if (!serviceProbe.reachable) {
        return { valid: false, error: `Crawl4AI service at "${crawl4aiUrl}" is not reachable: ${serviceProbe.error}` };
      }
    } catch {
      return { valid: false, error: "Crawl4AI service URL is not configured" };
    }

    return { valid: true, error: "" };
  }

  if (type === "searxng") {
    // For searxng, probe the SearXNG service health
    try {
      const configService: ConfigService = ConfigService.getInstance();
      const searxngUrl: string = configService.getConfig().services.searxngUrl;

      logger.debug("Probing SearXNG service", { searxngUrl });

      const serviceProbe = await probeUrlAsync(`${searxngUrl}/healthz`, "GET");

      if (!serviceProbe.reachable) {
        // Fallback: try the base URL
        const baseProbe = await probeUrlAsync(searxngUrl, "GET");

        if (!baseProbe.reachable) {
          return { valid: false, error: `SearXNG service at "${searxngUrl}" is not reachable: ${baseProbe.error}` };
        }
      }
    } catch {
      return { valid: false, error: "SearXNG service URL is not configured" };
    }

    return { valid: true, error: "" };
  }

  return { valid: true, error: "" };
}

//#endregion Public functions
