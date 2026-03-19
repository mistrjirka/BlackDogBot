import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { LogLevel } from "../shared/types/index.js";
import { getLogsDir } from "../utils/paths.js";
import { ConsoleColor } from "../utils/console-color.js";

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
  private _jobLogStreams: Map<string, fsSync.WriteStream> = new Map();
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

  public async openJobLogAsync(key: string, filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const stream: fsSync.WriteStream = fsSync.createWriteStream(filePath, { flags: "a", encoding: "utf-8" });
    this._jobLogStreams.set(key, stream);
  }

  public closeJobLog(key: string): void {
    const stream: fsSync.WriteStream | undefined = this._jobLogStreams.get(key);
    if (stream) {
      stream.end();
      this._jobLogStreams.delete(key);
    }
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

    const coloredLevelTag: string = ConsoleColor.enabled
      ? this._colorLevelTag(levelTag)
      : levelTag;

    const consoleLine: string = ConsoleColor.enabled
      ? `${ConsoleColor.gray(`[${timestamp}]`)} [${coloredLevelTag}] ${message}${contextSuffix}`
      : line;

    if (level === "error") {
      console.error(consoleLine);
    } else if (level === "warn") {
      console.warn(consoleLine);
    } else {
      console.log(consoleLine);
    }

    void this._writeToFileAsync(line);

    this.events.emit("log", { level, message, context, timestamp: new Date().toISOString() });
  }

  private async _writeToFileAsync(line: string): Promise<void> {
    if (this._logFilePath) {
      await fs.appendFile(this._logFilePath, line + "\n", "utf-8");
    }

    for (const stream of this._jobLogStreams.values()) {
      await new Promise<void>((resolve, reject): void => {
        stream.write(line + "\n", (err): void => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  private _colorLevelTag(levelTag: string): string {
    switch (levelTag) {
      case "ERROR": return ConsoleColor.brightRed(levelTag);
      case "WARN":  return ConsoleColor.yellow(levelTag);
      case "INFO":  return ConsoleColor.brightCyan(levelTag);
      case "DEBUG": return ConsoleColor.gray(levelTag);
      default:      return levelTag;
    }
  }

  //#endregion Private methods
}
