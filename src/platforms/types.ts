import type { IPlatformAdapter } from "../services/messaging.service.js";
import type { ChannelRegistryService } from "../services/channel-registry.service.js";
import type { MessagingService } from "../services/messaging.service.js";
import type { LoggerService } from "../services/logger.service.js";
import type * as ToolRegistry from "../helpers/tool-registry.js";
import type { IChatAgent } from "../agent/agent-interface.js";

//#region Platform Types

/**
 * Dependencies passed to platform initialization.
 * These services are available to all platforms.
 */
export interface IPlatformDeps {
  /** Agent instance for message processing */
  agent: IChatAgent;

  /** Channel registry for managing channels and permissions */
  channelRegistry: ChannelRegistryService;

  /** Messaging service for sending messages */
  messagingService: MessagingService;

  /** Tool registry helpers for permission-based tool filtering */
  toolRegistry: typeof ToolRegistry;

  /** Logger instance */
  logger: LoggerService;
}

/**
 * Platform configuration is stored in config.yaml under this key.
 */
export type ConfigKey = "telegram" | "discord" | string;

/**
 * Defines a messaging platform integration.
 *
 * Each platform (Telegram, Discord, Slack, etc.) implements this interface
 * to provide its adapter, handler, and initialization logic.
 */
export interface IPlatform<TConfig = unknown> {
  /** Unique platform identifier (e.g., "telegram", "discord") */
  readonly name: string;

  /** Key in config.yaml where this platform's config lives */
  readonly configKey?: ConfigKey;

  /** Human-readable display name for logs and UI */
  readonly displayName: string;

  /**
   * Create the messaging adapter for this platform.
   * The adapter handles sending messages through MessagingService.
   *
   * @param config Platform-specific configuration
   * @param deps Shared dependencies
   * @returns Platform adapter or null if not applicable
   */
  createAdapter(config: TConfig, deps: IPlatformDeps): IPlatformAdapter | null;

  /**
   * Initialize the platform.
   * - Start bot/connection
   * - Register adapter with MessagingService
   * - Set up message handlers
   * - Register channels with ChannelRegistry
   *
   * @param config Platform-specific configuration
   * @param deps Shared dependencies
   */
  initialize(config: TConfig, deps: IPlatformDeps): Promise<void>;

  /**
   * Stop the platform.
   * - Disconnect bot
   * - Cleanup resources
   */
  stop(): Promise<void>;

  /**
   * Check if this platform is enabled in the given config.
   * Default implementation checks if config is truthy.
   *
   * @param config Platform-specific configuration
   * @returns Whether the platform should be initialized
   */
  isEnabled?(config: TConfig): boolean;
}

//#endregion Platform Types
