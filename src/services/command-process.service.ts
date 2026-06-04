import { spawn, ChildProcess } from "node:child_process";

import { LoggerService } from "./logger.service.js";

//#region Types

export type ProcessStatus = "completed" | "awaiting_input" | "running" | "timed_out" | "killed" | "failed";

export interface IProcessEntry {
  child: ChildProcess;
  pid: number;
  handleId: string;
  startedAt: Date;
  status: ProcessStatus;
  stdout: Buffer;
  stderr: Buffer;
  timeoutTimer: NodeJS.Timeout | null;
  lastReadOffsetStdout: number;
  lastReadOffsetStderr: number;
  signal: string | null;
  exitCode: number | null;
  error: string | null;
  resolved: boolean;
  promise: Promise<void>;
  resolveFn: (() => void) | null;
  rejectFn: ((error: Error) => void) | null;
}

export interface ISpawnResult {
  handleId: string;
  child: ChildProcess;
  status: ProcessStatus;
}

export interface ISendInputResult {
  stdout: string;
  stderr: string;
  status: ProcessStatus;
}

export interface ICmdStatusResult {
  status: ProcessStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  error: string | null;
}

export interface ICmdOutputResult {
  data: string;
  truncated: boolean;
}

export interface IStopResult {
  success: boolean;
  error?: string;
}

//#endregion Types

//#region Constants

const MAX_BUFFER_SIZE: number = 1024 * 1024; // 1MB
const TIMEOUT_GRACE_MS: number = 5000;

//#endregion Constants

export class CommandProcessService {
  //#region Data members

  private static _instance: CommandProcessService | null;
  private _logger: LoggerService;
  private _processes: Map<string, IProcessEntry>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._processes = new Map();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): CommandProcessService {
    if (!CommandProcessService._instance) {
      CommandProcessService._instance = new CommandProcessService();
    }

    return CommandProcessService._instance;
  }

  public async spawnProcessAsync(
    command: string,
    cwd: string,
    timeout: number,
    env?: NodeJS.ProcessEnv,
  ): Promise<ISpawnResult> {
    const handleId: string = this._generateHandleId();

    this._logger.debug("Spawning process", { handleId, command, cwd, timeout });

    const child: ChildProcess = spawn(command, [], {
      shell: true,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const stdout: Buffer = Buffer.alloc(0);
    const stderr: Buffer = Buffer.alloc(0);

    let resolveFn: (() => void) | null = null;
    let rejectFn: ((error: Error) => void) | null = null;

    const promise: Promise<void> = new Promise<void>((resolve, reject): void => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const entry: IProcessEntry = {
      child,
      pid: child.pid ?? 0,
      handleId,
      startedAt: new Date(),
      status: "running",
      stdout,
      stderr,
      timeoutTimer: null,
      lastReadOffsetStdout: 0,
      lastReadOffsetStderr: 0,
      signal: null,
      exitCode: null,
      error: null,
      resolved: false,
      promise,
      resolveFn,
      rejectFn,
    };

    // Setup stdout handler
    child.stdout?.on("data", (data: Buffer): void => {
      entry.stdout = this._appendBuffer(entry.stdout, data);
    });

    // Setup stderr handler
    child.stderr?.on("data", (data: Buffer): void => {
      entry.stderr = this._appendBuffer(entry.stderr, data);
    });

    // Setup exit handler
    child.on("exit", (code: number | null, signal: string | null): void => {
      if (entry.status === "running" || entry.status === "awaiting_input") {
        entry.status = code === 0 ? "completed" : "failed";
      }
      entry.exitCode = code;
      entry.signal = signal;

      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }

      this._resolveEntry(entry);
      this._logger.debug("Process exited", { handleId, exitCode: code, signal });
    });

    // Setup error handler
    child.on("error", (error: Error): void => {
      entry.error = error.message;
      entry.status = "failed";
      this._rejectEntry(entry, error);
      this._logger.error("Process error", { handleId, error: error.message });
    });

    // Store the entry
    this._processes.set(handleId, entry);

    // Start timeout timer
    if (timeout > 0) {
      entry.timeoutTimer = setTimeout((): void => {
        this._handleTimeout(entry);
      }, timeout);
    }

    this._logger.info("Process spawned", { handleId, pid: entry.pid });

    return {
      handleId,
      child,
      status: entry.status,
    };
  }

  public async sendInputAsync(
    handleId: string,
    input: string,
    closeStdin: boolean,
  ): Promise<ISendInputResult> {
    const entry: IProcessEntry | undefined = this._processes.get(handleId);

    if (!entry) {
      throw new Error(`Process not found: ${handleId}`);
    }

    if (entry.status === "awaiting_input") {
      entry.status = "running";
      this._logger.debug("Process resumed from awaiting_input", { handleId });
    }

    if (entry.child.stdin) {
      entry.child.stdin.write(input);

      if (closeStdin) {
        entry.child.stdin.end();
      }
    }

    const stdoutSinceLastRead: string = this._getOutputSince(entry, "stdout", entry.lastReadOffsetStdout);
    const stderrSinceLastRead: string = this._getOutputSince(entry, "stderr", entry.lastReadOffsetStderr);

    entry.lastReadOffsetStdout = entry.stdout.length;
    entry.lastReadOffsetStderr = entry.stderr.length;

    return {
      stdout: stdoutSinceLastRead,
      stderr: stderrSinceLastRead,
      status: entry.status,
    };
  }

  public getStatus(handleId: string): ICmdStatusResult {
    const entry: IProcessEntry | undefined = this._processes.get(handleId);

    if (!entry) {
      return {
        status: "completed",
        pid: null,
        exitCode: null,
        signal: null,
        startedAt: "",
        durationMs: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        error: `Process not found: ${handleId}`,
      };
    }

    const durationMs: number | null = entry.status === "running" || entry.status === "awaiting_input"
      ? Date.now() - entry.startedAt.getTime()
      : null;

    return {
      status: entry.status,
      pid: entry.pid,
      exitCode: entry.exitCode,
      signal: entry.signal,
      startedAt: entry.startedAt.toISOString(),
      durationMs,
      stdoutBytes: entry.stdout.length,
      stderrBytes: entry.stderr.length,
      error: entry.error,
    };
  }

  public getOutput(handleId: string, channel: "stdout" | "stderr", maxBytes: number): ICmdOutputResult {
    const entry: IProcessEntry | undefined = this._processes.get(handleId);

    if (!entry) {
      return {
        data: "",
        truncated: false,
      };
    }

    const buffer: Buffer = channel === "stdout" ? entry.stdout : entry.stderr;
    const truncated: boolean = buffer.length > maxBytes;
    const data: string = truncated
      ? buffer.subarray(buffer.length - maxBytes).toString("utf-8")
      : buffer.toString("utf-8");

    return {
      data,
      truncated,
    };
  }

  public async stopAsync(handleId: string, signal: "SIGTERM" | "SIGKILL" | "SIGINT" = "SIGTERM"): Promise<IStopResult> {
    const entry: IProcessEntry | undefined = this._processes.get(handleId);

    if (!entry) {
      return {
        success: false,
        error: `Process not found: ${handleId}`,
      };
    }

    if (entry.status === "completed" || entry.status === "killed" || entry.status === "timed_out") {
      return {
        success: false,
        error: `Process already terminated: ${entry.status}`,
      };
    }

    this._logger.info("Stopping process", { handleId, signal });

    try {
      entry.child.kill(signal);
      entry.status = "killed";

      return {
        success: true,
      };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  public onStdinBlocked(handleId: string): void {
    const entry: IProcessEntry | undefined = this._processes.get(handleId);

    if (!entry) {
      this._logger.warn("Stdin blocked for unknown handle", { handleId });
      return;
    }

    if (entry.status === "running") {
      entry.status = "awaiting_input";
      this._logger.debug("Process marked as awaiting_input", { handleId });
    }
  }

  public removeHandle(handleId: string): void {
    const entry: IProcessEntry | undefined = this._processes.get(handleId);

    if (entry) {
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
      }

      this._processes.delete(handleId);
      this._logger.debug("Process handle removed", { handleId });
    }
  }

  public getEntry(handleId: string): IProcessEntry | undefined {
    return this._processes.get(handleId);
  }

  //#endregion Public methods

  //#region Private methods

  private _generateHandleId(): string {
    const uuid: string = crypto.randomUUID().replace(/-/g, "");
    return uuid.substring(0, 16);
  }

  private _appendBuffer(existing: Buffer, data: Buffer): Buffer {
    const combined: Buffer = Buffer.concat([existing, data]);

    if (combined.length > MAX_BUFFER_SIZE) {
      return combined.subarray(combined.length - MAX_BUFFER_SIZE);
    }

    return combined;
  }

  private _getOutputSince(entry: IProcessEntry, channel: "stdout" | "stderr", offset: number): string {
    const buffer: Buffer = channel === "stdout" ? entry.stdout : entry.stderr;

    if (offset >= buffer.length) {
      return "";
    }

    return buffer.subarray(offset).toString("utf-8");
  }

  private _resolveEntry(entry: IProcessEntry): void {
    if (!entry.resolved) {
      entry.resolved = true;
      if (entry.resolveFn) {
        entry.resolveFn();
      }
    }
  }

  private _rejectEntry(entry: IProcessEntry, error: Error): void {
    if (!entry.resolved) {
      entry.resolved = true;
      if (entry.rejectFn) {
        entry.rejectFn(error);
      }
    }
  }

  private _handleTimeout(entry: IProcessEntry): void {
    this._logger.warn("Process timed out", { handleId: entry.handleId });

    entry.status = "timed_out";

    try {
      entry.child.kill("SIGTERM" as const);

      setTimeout((): void => {
        if (entry.child.exitCode === null) {
          this._logger.warn("Process did not exit after SIGTERM, sending SIGKILL", {
            handleId: entry.handleId,
          });
            try {
            entry.child.kill("SIGKILL" as const);
          } catch {
            // Process may have already exited
          }
        }
      }, TIMEOUT_GRACE_MS);
    } catch (error: unknown) {
      this._logger.error("Failed to kill timed out process", {
        handleId: entry.handleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  //#endregion Private methods
}
