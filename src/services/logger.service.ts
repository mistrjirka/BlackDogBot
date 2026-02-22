import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { LogLevel } from "../shared/types/index.js";
import { getLogsDir } from "../utils/paths.js";

//#region Constants

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

//#endregion Constants

export class LoggerService {
  //#region Data members

  private static _instance: LoggerService | null;
  private _logLevel: LogLevel;
  private _logFilePath: string | null;
  public readonly events: EventEmitter = new EventEmitter();

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logLevel = "info";
    this._logFilePath = null;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): LoggerService {
    if (!LoggerService._instance) {
      LoggerService._instance = new LoggerService();
    }

    return LoggerService._instance;
  }

  public async initializeAsync(
    level: LogLevel,
    logDir?: string,
  ): Promise<void> {
    this._logLevel = level;

    const resolvedLogDir: string = logDir ?? getLogsDir();
    const now: Date = new Date();
    const dateString: string = now.toISOString().split("T")[0];
    const logFileName: string = `betterclaw-${dateString}.log`;

    await fs.mkdir(resolvedLogDir, { recursive: true });

    this._logFilePath = path.join(resolvedLogDir, logFileName);
  }

  public setLogLevel(level: LogLevel): void {
    this._logLevel = level;
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this._log("debug", message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this._log("info", message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this._log("warn", message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this._log("error", message, context);
  }

  //#endregion Public methods

  //#region Private methods

  private _log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this._logLevel]) {
      return;
    }

    const timestamp: string = new Date().toISOString();
    const levelTag: string = level.toUpperCase();
    const contextSuffix: string = context
      ? ` ${JSON.stringify(context)}`
      : "";
    const line: string = `[${timestamp}] [${levelTag}] ${message}${contextSuffix}`;

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    void this._writeToFileAsync(line);

    this.events.emit("log", { level, message, context, timestamp: new Date().toISOString() });
  }

  private async _writeToFileAsync(line: string): Promise<void> {
    if (!this._logFilePath) {
      return;
    }

    await fs.appendFile(this._logFilePath, line + "\n", "utf-8");
  }

  //#endregion Private methods
}
