import { LoggerService } from "../services/logger.service.js";

/**
 * Configuration for limiting think operations to prevent excessive token accumulation.
 */
export interface ThinkLimitConfig {
  /**
   * Maximum number of think operations allowed before triggering a warning.
   * Default: 20
   */
  maxThinkOperations?: number;

  /**
   * Maximum total characters allowed across all think operations.
   * Default: 50,000 (approx. 12,500 tokens)
   */
  maxTotalThinkCharacters?: number;
}

/**
 * Tracks think operations to prevent excessive token accumulation.
 */
export class ThinkOperationTracker {
  private _thinkCount: number = 0;
  private _totalThinkCharacters: number = 0;
  private _maxThinkCount: number;
  private _maxTotalCharacters: number;
  private _logger: LoggerService;

  constructor(config: ThinkLimitConfig = {}) {
    this._logger = LoggerService.getInstance();
    this._maxThinkCount = config.maxThinkOperations ?? 20;
    this._maxTotalCharacters = config.maxTotalThinkCharacters ?? 50000;

    this._logger.info("ThinkOperationTracker initialized", {
      maxThinkOperations: this._maxThinkCount,
      maxTotalCharacters: this._maxTotalCharacters,
    });
  }

  /**
   * Record a think operation and check if limits are being approached.
   * Returns the thought and whether it was truncated (always false - truncation disabled).
   */
  recordThinkOperation(thought: string): { thought: string; wasTruncated: boolean } {
    this._thinkCount++;
    const thoughtLength = thought.length;
    this._totalThinkCharacters += thoughtLength;

    // Check if we're approaching limits
    if (this._thinkCount >= this._maxThinkCount * 0.8) {
      this._logger.warn("Approaching think operation limit", {
        currentCount: this._thinkCount,
        maxCount: this._maxThinkCount,
        percentage: Math.round((this._thinkCount / this._maxThinkCount) * 100),
      });
    }

    if (this._totalThinkCharacters >= this._maxTotalCharacters * 0.8) {
      this._logger.warn("Approaching total think characters limit", {
        currentCharacters: this._totalThinkCharacters,
        maxCharacters: this._maxTotalCharacters,
        percentage: Math.round((this._totalThinkCharacters / this._maxTotalCharacters) * 100),
      });
    }

    // Check if limits exceeded
    if (this._thinkCount > this._maxThinkCount) {
      this._logger.error("Think operation limit exceeded", {
        currentCount: this._thinkCount,
        maxCount: this._maxThinkCount,
        action: "Consider using summary/think for RSS items instead of individual think calls",
      });
    }

    if (this._totalThinkCharacters > this._maxTotalCharacters) {
      this._logger.error("Total think characters limit exceeded", {
        currentCharacters: this._totalThinkCharacters,
        maxCharacters: this._maxTotalCharacters,
        action: "Consider summarizing thoughts instead of storing full content",
      });
    }

    return { thought, wasTruncated: false };
  }

  /**
   * Get current statistics.
   */
  getStats() {
    return {
      thinkCount: this._thinkCount,
      totalCharacters: this._totalThinkCharacters,
      estimatedTokens: Math.ceil(this._totalThinkCharacters / 4),
      maxThinkCount: this._maxThinkCount,
      maxTotalCharacters: this._maxTotalCharacters,
      withinLimits: this._thinkCount <= this._maxThinkCount && 
                   this._totalThinkCharacters <= this._maxTotalCharacters,
    };
  }

  /**
   * Reset the tracker (e.g., for new task execution).
   */
  reset(): void {
    this._thinkCount = 0;
    this._totalThinkCharacters = 0;
    this._logger.info("ThinkOperationTracker reset");
  }
}
