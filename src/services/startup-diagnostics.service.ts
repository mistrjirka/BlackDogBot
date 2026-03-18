/**
 * Startup diagnostics service - verifies configured services are reachable
 * when the daemon starts.
 */

import { LoggerService } from "./logger.service.js";
import { ConfigService } from "./config.service.js";
import { fetchWithTimeout } from "../utils/fetch-with-timeout.js";

export interface IServiceHealth {
  name: string;
  url: string;
  healthy: boolean;
  responseTime?: number;
  error?: string;
}

export interface IDiagnosticResult {
  services: IServiceHealth[];
  allHealthy: boolean;
  timestamp: number;
}

export class StartupDiagnosticsService {
  private static _instance: StartupDiagnosticsService | null;
  private _result: IDiagnosticResult | null;
  private _unhealthyServices: Set<string>;

  private constructor() {
    this._result = null;
    this._unhealthyServices = new Set();
  }

  public static getInstance(): StartupDiagnosticsService {
    if (!StartupDiagnosticsService._instance) {
      StartupDiagnosticsService._instance = new StartupDiagnosticsService();
    }
    return StartupDiagnosticsService._instance;
  }

  /**
   * Run all diagnostic checks and log results.
   */
  public async runDiagnosticsAsync(): Promise<IDiagnosticResult> {
    const logger = LoggerService.getInstance();
    const configService = ConfigService.getInstance();
    const config = configService.getConfig();

    const services: IServiceHealth[] = [];

    // Check SearXNG
    const searxngUrl = config.services?.searxngUrl;
    if (searxngUrl) {
      const searxngHealth = await this._checkHttpService("SearXNG", searxngUrl);
      services.push(searxngHealth);
    }

    // Check Crawl4AI
    const crawl4aiUrl = config.services?.crawl4aiUrl;
    if (crawl4aiUrl) {
      const crawl4aiHealth = await this._checkCrawl4AI("Crawl4AI", crawl4aiUrl);
      services.push(crawl4aiHealth);
    }

    // Build result
    const allHealthy = services.every((s) => s.healthy);
    const result: IDiagnosticResult = {
      services,
      allHealthy,
      timestamp: Date.now(),
    };

    this._result = result;

    // Track unhealthy services for runtime fallback
    this._unhealthyServices.clear();
    for (const service of services) {
      if (!service.healthy) {
        this._unhealthyServices.add(service.name.toLowerCase());
      }
    }

    // Log results
    logger.info("Startup diagnostics:");
    for (const service of services) {
      const icon = service.healthy ? "✓" : "✗";
      const timeStr = service.responseTime ? ` (${service.responseTime}ms)` : "";
      const errorStr = service.error ? ` - ${service.error}` : "";

      if (service.healthy) {
        logger.info(`  ${icon} ${service.name} (${service.url})${timeStr}`);
      } else {
        logger.warn(`  ${icon} ${service.name} (${service.url}): ${service.error}`);
      }
    }

    if (!allHealthy) {
      const unhealthyNames = services
        .filter((s) => !s.healthy)
        .map((s) => s.name)
        .join(", ");
      logger.warn(
        `Some services are not available: ${unhealthyNames}. The agent will use fallback methods.`,
      );
    }

    return result;
  }

  /**
   * Check if a service is currently marked as unhealthy.
   */
  public isServiceUnhealthy(serviceName: string): boolean {
    return this._unhealthyServices.has(serviceName.toLowerCase());
  }

  /**
   * Get the last diagnostic result.
   */
  public getLastResult(): IDiagnosticResult | null {
    return this._result;
  }

  /**
   * Mark a service as unhealthy at runtime (called when a service fails repeatedly).
   */
  public markServiceUnhealthy(serviceName: string): void {
    this._unhealthyServices.add(serviceName.toLowerCase());
  }

  /**
   * Mark a service as healthy at runtime (called when a service recovers).
   */
  public markServiceHealthy(serviceName: string): void {
    this._unhealthyServices.delete(serviceName.toLowerCase());
  }

  /**
   * Get list of currently unhealthy services.
   */
  public getUnhealthyServices(): string[] {
    return Array.from(this._unhealthyServices);
  }

  /**
   * Check a simple HTTP endpoint.
   */
  private async _checkHttpService(name: string, url: string): Promise<IServiceHealth> {
    const startTime = Date.now();

    try {
      const response = await fetchWithTimeout(url, { method: "GET" }, 5000);
      const responseTime = Date.now() - startTime;

      if (response.ok) {
        return { name, url, healthy: true, responseTime };
      } else {
        return {
          name,
          url,
          healthy: false,
          responseTime,
          error: `HTTP ${response.status}`,
        };
      }
    } catch (error: unknown) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        name,
        url,
        healthy: false,
        responseTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Check Crawl4AI specifically (has /crawl endpoint).
   */
  private async _checkCrawl4AI(name: string, url: string): Promise<IServiceHealth> {
    const startTime = Date.now();

    try {
      // Try a simple crawl request with a quick timeout
      const response = await fetchWithTimeout(
        `${url}/crawl`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: ["about:blank"],
            crawler_config: { cache_mode: "bypass" },
          }),
        },
        10000,
      );
      const responseTime = Date.now() - startTime;

      if (response.ok || response.status === 400) {
        // 400 is OK - means the service is responding even if the request was invalid
        return { name, url, healthy: true, responseTime };
      } else {
        return {
          name,
          url,
          healthy: false,
          responseTime,
          error: `HTTP ${response.status}`,
        };
      }
    } catch (error: unknown) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        name,
        url,
        healthy: false,
        responseTime,
        error: errorMessage,
      };
    }
  }
}
