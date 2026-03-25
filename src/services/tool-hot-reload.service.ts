type ToolSet = Record<string, unknown>;
import { LoggerService } from "./logger.service.js";

type RebuildCallback = (perTableTools: ToolSet) => void;

/**
 * Singleton service that allows tools to trigger a hot-reload of the
 * agent's tool set. Used when create_table creates a new table and
 * the corresponding per-table write tool should become available
 * immediately.
 */
export class ToolHotReloadService {
  //#region Data Members

  private static _instance: ToolHotReloadService | null;
  private _logger: LoggerService;
  private _rebuildCallbacks: Map<string, RebuildCallback>;

  //#endregion Data Members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._rebuildCallbacks = new Map();
  }

  //#endregion Constructors

  //#region Public Methods

  public static getInstance(): ToolHotReloadService {
    if (!ToolHotReloadService._instance) {
      ToolHotReloadService._instance = new ToolHotReloadService();
    }
    return ToolHotReloadService._instance;
  }

  /**
   * Register a rebuild callback for a specific chat session.
   * The callback receives the updated per-table tools and should
   * rebuild the agent's tool set.
   */
  public registerRebuildCallback(chatId: string, callback: RebuildCallback): void {
    this._rebuildCallbacks.set(chatId, callback);
    this._logger.debug("Tool hot-reload callback registered", { chatId });
  }

  /**
   * Unregister the rebuild callback for a chat session.
   */
  public unregisterRebuildCallback(chatId: string): void {
    this._rebuildCallbacks.delete(chatId);
  }

  /**
   * Trigger a rebuild of per-table tools and notify all registered callbacks.
   * Called by create_table tool after a new table is created.
   */
  public async triggerRebuildAsync(chatId: string): Promise<boolean> {
    const callback: RebuildCallback | undefined = this._rebuildCallbacks.get(chatId);

    if (!callback) {
      this._logger.debug("No hot-reload callback registered for chat", { chatId });
      return false;
    }

    try {
      const { buildPerTableToolsAsync } = await import("../utils/per-table-tools.js");
      const perTableTools = await buildPerTableToolsAsync() as Record<string, unknown>;

      this._logger.info("Triggering tool hot-reload", {
        chatId,
        toolCount: Object.keys(perTableTools).length,
      });

      callback(perTableTools);
      return true;
    } catch (err: unknown) {
      this._logger.error("Tool hot-reload failed", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  //#endregion Public Methods
}
