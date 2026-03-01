import type { IPlatform, IPlatformDeps } from "./types.js";
import { LoggerService } from "../services/logger.service.js";
import { ConfigService } from "../services/config.service.js";

//#region Platform Registry

/**
 * Registry for all available platforms.
 * Platforms register themselves here on import.
 */
class PlatformRegistry {
  private _platforms: Map<string, IPlatform> = new Map();
  private _logger: LoggerService;

  constructor() {
    this._logger = LoggerService.getInstance();
  }

  /**
   * Register a platform.
   * Called by platform modules on import.
   */
  register(platform: IPlatform): void {
    if (this._platforms.has(platform.name)) {
      this._logger.warn("Platform already registered, replacing", {
        name: platform.name,
      });
    }
    this._platforms.set(platform.name, platform);
    this._logger.debug("Platform registered", { name: platform.name });
  }

  /**
   * Get a platform by name.
   */
  get(name: string): IPlatform | undefined {
    return this._platforms.get(name);
  }

  /**
   * Get all registered platforms.
   */
  getAll(): IPlatform[] {
    return Array.from(this._platforms.values());
  }

  /**
   * Get platform names.
   */
  getNames(): string[] {
    return Array.from(this._platforms.keys());
  }
}

// Singleton instance
const registry = new PlatformRegistry();

//#endregion Platform Registry

//#region Platform Manager

/**
 * Manages platform lifecycle (initialization, shutdown).
 */
export class PlatformManager {
  private _logger: LoggerService;
  private _initializedPlatforms: Set<string> = new Set();

  constructor() {
    this._logger = LoggerService.getInstance();
  }

  /**
   * Initialize all enabled platforms.
   *
   * @param deps Shared dependencies for all platforms
   */
  async initializeAll(deps: IPlatformDeps): Promise<void> {
    const config = ConfigService.getInstance().getConfig();
    const platforms = registry.getAll();

    this._logger.info("Initializing platforms", {
      count: platforms.length,
      platforms: platforms.map((p) => p.name),
    });

    for (const platform of platforms) {
      // Get platform config
      const configKey = platform.configKey;
      if (!configKey) {
        this._logger.debug("Platform has no configKey, skipping", {
          name: platform.name,
        });
        continue;
      }

      // @ts-expect-error - Dynamic config access
      const platformConfig = config[configKey];

      // Check if enabled
      const isEnabled =
        platform.isEnabled?.(platformConfig) ?? !!platformConfig;
      if (!isEnabled) {
        this._logger.debug("Platform disabled, skipping", {
          name: platform.name,
        });
        continue;
      }

      // Initialize
      try {
        this._logger.info("Initializing platform", { name: platform.name });
        await platform.initialize(platformConfig, deps);
        this._initializedPlatforms.add(platform.name);

        this._logger.info("Platform initialized successfully", {
          name: platform.name,
        });
      } catch (error) {
        this._logger.error("Failed to initialize platform", {
          name: platform.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Stop all initialized platforms.
   */
  async stopAll(): Promise<void> {
    this._logger.info("Stopping platforms");

    for (const platformName of this._initializedPlatforms) {
      const platform = registry.get(platformName);
      if (platform) {
        try {
          await platform.stop();
          this._logger.info("Platform stopped", { name: platformName });
        } catch (error) {
          this._logger.error("Failed to stop platform", {
            name: platformName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    this._initializedPlatforms.clear();
  }

  /**
   * Get list of initialized platform names.
   */
  getInitializedPlatforms(): string[] {
    return Array.from(this._initializedPlatforms);
  }
}

//#endregion Platform Manager

//#region Exports

/**
 * Register a platform.
 * Call this in each platform's index.ts.
 */
export function registerPlatform(platform: IPlatform): void {
  registry.register(platform);
}

/**
 * Get the platform registry (for advanced use).
 */
export function getPlatformRegistry(): PlatformRegistry {
  return registry;
}

/**
 * Create a new PlatformManager instance.
 */
export function createPlatformManager(): PlatformManager {
  return new PlatformManager();
}

//#endregion Exports
