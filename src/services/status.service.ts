import { EventEmitter } from "node:events";
import { getEncoding } from "js-tiktoken";

//#region Types

export type StatusType =
  | "idle"
  | "llm_request"
  | "embedding"
  | "job_execution"
  | "skill_setup"
  | "tool_execution"
  | "web_search"
  | "web_crawl"
  | "http_request";

export interface IStatusState {
  type: StatusType;
  message: string;
  details: Record<string, unknown>;
  startedAt: number;
  inputTokens?: number;
  contextTokens?: number;
}

export interface IStatusUpdateEvent {
  previous: IStatusState | null;
  current: IStatusState | null;
}

//#endregion Types

//#region Constants

const SPINNER_FRAMES: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

//#endregion Constants

//#region Class

export class StatusService {
  //#region Data members

  private static _instance: StatusService | null = null;
  private _currentState: IStatusState | null = null;
  private _contextTokens: number = 0;
  private _encoder: ReturnType<typeof getEncoding> | null = null;
  private _spinnerIndex: number = 0;
  private _spinnerInterval: NodeJS.Timeout | null = null;
  private _cliEnabled: boolean = false;

  public readonly events: EventEmitter = new EventEmitter();

  //#endregion Data members

  //#region Constructors

  private constructor() {
    // Initialize tiktoken with cl100k_base encoding (used by GPT-4, Claude, etc.)
    try {
      this._encoder = getEncoding("cl100k_base");
    } catch (error) {
      console.warn("Failed to initialize tiktoken encoder, using fallback:", error);
    }
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): StatusService {
    if (!StatusService._instance) {
      StatusService._instance = new StatusService();
    }

    return StatusService._instance;
  }

  public enableCliOutput(enabled: boolean): void {
    this._cliEnabled = enabled;

    if (enabled && !this._spinnerInterval) {
      this._startSpinner();
    } else if (!enabled && this._spinnerInterval) {
      this._stopSpinner();
    }
  }

  public countTokens(text: string): number {
    if (!this._encoder) {
      // Fallback: approximate token count (4 chars per token)
      return Math.ceil(text.length / 4);
    }

    try {
      return this._encoder.encode(text).length;
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  public countMessagesTokens(messages: Array<{ role: string; content: string }>): number {
    let total: number = 0;

    for (const msg of messages) {
      // Add tokens for role and content
      total += this.countTokens(msg.role);
      total += this.countTokens(msg.content);
      // Add overhead for message structure (~4 tokens per message)
      total += 4;
    }

    return total;
  }

  /**
   * Update the context token count (total tokens in conversation history).
   * This should be called whenever messages are added/removed from context.
   */
  public setContextTokens(count: number): void {
    this._contextTokens = count;

    // Emit update if we have an active status
    if (this._currentState) {
      this._currentState.contextTokens = count;
      this.events.emit("status_update", {
        previous: this._currentState,
        current: this._currentState,
      });
    }
  }

  /**
   * Get the current context token count.
   */
  public getContextTokens(): number {
    return this._contextTokens;
  }

  public setStatus(
    type: StatusType,
    message: string,
    details: Record<string, unknown> = {},
  ): void {
    const previous: IStatusState | null = this._currentState;

    this._currentState = {
      type,
      message,
      details,
      startedAt: Date.now(),
      inputTokens: details.inputTokens as number | undefined,
      contextTokens: this._contextTokens,
    };

    this.events.emit("status_update", {
      previous,
      current: this._currentState,
    } as IStatusUpdateEvent);

    if (this._cliEnabled) {
      this._renderStatus();
    }
  }

  public clearStatus(): void {
    const previous: IStatusState | null = this._currentState;

    this._currentState = null;

    this.events.emit("status_update", {
      previous,
      current: null,
    } as IStatusUpdateEvent);

    if (this._cliEnabled) {
      this._clearCliLine();
    }
  }

  public getCurrentStatus(): IStatusState | null {
    return this._currentState;
  }

  public formatStatus(state: IStatusState | null): string {
    if (!state) {
      return "Idle";
    }

    const elapsed: number = Math.round((Date.now() - state.startedAt) / 1000);
    const elapsedStr: string = elapsed > 0 ? ` (${elapsed}s)` : "";
    const contextStr: string = state.contextTokens
      ? ` [${state.contextTokens.toLocaleString()} context]`
      : "";

    switch (state.type) {
      case "llm_request": {
        const tokens: string = state.inputTokens
          ? ` (${state.inputTokens.toLocaleString()} input tokens)`
          : "";
        return `🤖 LLM: ${state.message}${tokens}${contextStr}${elapsedStr}`;
      }

      case "embedding":
        return `🔢 Embedding: ${state.message}${contextStr}${elapsedStr}`;

      case "job_execution":
        return `⚙️ Job: ${state.message}${contextStr}${elapsedStr}`;

      case "skill_setup":
        return `🔧 Skill Setup: ${state.message}${contextStr}${elapsedStr}`;

      case "tool_execution":
        return `🔨 Tool: ${state.message}${contextStr}${elapsedStr}`;

      case "web_search":
        return `🔍 Search: ${state.message}${contextStr}${elapsedStr}`;

      case "web_crawl":
        return `🕷️ Crawl: ${state.message}${contextStr}${elapsedStr}`;

      case "http_request":
        return `🌐 HTTP: ${state.message}${contextStr}${elapsedStr}`;

      default:
        return `${state.message}${contextStr}${elapsedStr}`;
    }
  }

  //#endregion Public methods

  //#region Private methods

  private _startSpinner(): void {
    this._spinnerInterval = setInterval(() => {
      this._spinnerIndex = (this._spinnerIndex + 1) % SPINNER_FRAMES.length;

      if (this._currentState) {
        this._renderStatus();
      }
    }, 80);
  }

  private _stopSpinner(): void {
    if (this._spinnerInterval) {
      clearInterval(this._spinnerInterval);
      this._spinnerInterval = null;
    }

    this._clearCliLine();
  }

  private _renderStatus(): void {
    if (!this._currentState) {
      return;
    }

    const spinner: string = SPINNER_FRAMES[this._spinnerIndex];
    const statusText: string = this.formatStatus(this._currentState);

    // Clear line and write new status
    process.stdout.write(`\r\x1b[K${spinner} ${statusText}`);
  }

  private _clearCliLine(): void {
    process.stdout.write("\r\x1b[K");
  }

  //#endregion Private methods
}

//#endregion Class
