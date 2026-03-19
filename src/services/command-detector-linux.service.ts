import fs from "node:fs";
import { spawn, execSync } from "node:child_process";

import { LoggerService } from "./logger.service.js";

//#region Constants

const STRACE_TIMEOUT_MS: number = 5000;

//#endregion Constants

//#region Interfaces

export interface IDetectorEntry {
  handleId: string;
  pid: number;
  straceProcess: ReturnType<typeof spawn>;
  onStdinBlocked: (() => void) | null;
  isActive: boolean;
}

export interface IStartResult {
  handleId: string;
  available: boolean;
  error?: string;
}

//#endregion Interfaces

export class CommandDetectorLinuxService {
  //#region Data members

  private static _instance: CommandDetectorLinuxService | null;
  private _logger: LoggerService;
  private _detectors: Map<string, IDetectorEntry>;
  private _stracePath: string | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._detectors = new Map();
    this._stracePath = null;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): CommandDetectorLinuxService {
    if (!CommandDetectorLinuxService._instance) {
      CommandDetectorLinuxService._instance = new CommandDetectorLinuxService();
    }

    return CommandDetectorLinuxService._instance;
  }

  public async startAsync(pid: number, onStdinBlocked: () => void): Promise<IStartResult> {
    try {
      if (!this._stracePath) {
        const straceCheck: string | null = this._checkStraceExists();

        if (!straceCheck) {
          return {
            handleId: "",
            available: false,
            error: "strace not found. Install strace to enable stdin detection.",
          };
        }

        this._stracePath = straceCheck;
      }

      const ptraceAvailable: boolean = this._checkPtraceAvailability();

      if (!ptraceAvailable) {
        return {
          handleId: "",
          available: false,
          error: "ptrace is not available. Check /proc/sys/kernel/yama/ptrace_scope.",
        };
      }

      const handleId: string = this._generateHandleId();
      const straceProcess: ReturnType<typeof spawn> = spawn(this._stracePath, [
        "-f",
        "-e",
        "trace=read,poll,ppoll,pselect,pselect6,select",
        "-p",
        pid.toString(),
        "-o",
        "/dev/stdout",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      const entry: IDetectorEntry = {
        handleId,
        pid,
        straceProcess,
        onStdinBlocked,
        isActive: true,
      };

      this._detectors.set(handleId, entry);

      straceProcess.stdout?.on("data", (data: Buffer): void => {
        this._parseStraceOutput(handleId, data.toString());
      });

      straceProcess.stderr?.on("data", (data: Buffer): void => {
        this._logger.debug("strace stderr", { handleId, data: data.toString() });
      });

      straceProcess.on("error", (error: Error): void => {
        this._logger.error("strace process error", { handleId, pid, error: error.message });
        void this.stopAsync(handleId);
      });

      straceProcess.on("exit", (code: number | null, signal: string | null): void => {
        this._logger.debug("strace process exited", { handleId, pid, code, signal });
        this._detectors.delete(handleId);
      });

      this._logger.debug("strace detector started", { handleId, pid });

      return { handleId, available: true };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);

      this._logger.error("Failed to start detector", { pid, error: errorMessage });

      return {
        handleId: "",
        available: false,
        error: `Failed to start detector: ${errorMessage}`,
      };
    }
  }

  public async stopAsync(detectorHandleId: string): Promise<void> {
    try {
      const entry: IDetectorEntry | undefined = this._detectors.get(detectorHandleId);

      if (!entry) {
        return;
      }

      entry.isActive = false;

      if (entry.straceProcess && !entry.straceProcess.killed) {
        try {
          process.kill(entry.straceProcess.pid!, "SIGTERM");

          setTimeout((): void => {
            if (!entry.straceProcess.killed) {
              try {
                process.kill(entry.straceProcess.pid!, "SIGKILL");
              } catch {
                // Process may already be dead
              }
            }
          }, 1000);
        } catch {
          // Process may already be dead
        }
      }

      this._detectors.delete(detectorHandleId);

      this._logger.debug("Detector stopped", { handleId: detectorHandleId });
    } catch (error: unknown) {
      this._logger.error("Error stopping detector", {
        handleId: detectorHandleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async stopAllAsync(): Promise<void> {
    const handleIds: string[] = Array.from(this._detectors.keys());

    for (const handleId of handleIds) {
      await this.stopAsync(handleId);
    }
  }

  public getActiveDetectorCount(): number {
    return this._detectors.size;
  }

  //#endregion Public methods

  //#region Private methods

  private _generateHandleId(): string {
    return `detector_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private _checkStraceExists(): string | null {
    try {
      const whichResult: string = execSync("which strace", {
        encoding: "utf-8",
        timeout: STRACE_TIMEOUT_MS,
      }).trim();

      if (whichResult && whichResult.length > 0) {
        return whichResult;
      }

      return null;
    } catch {
      return null;
    }
  }

  private _checkPtraceAvailability(): boolean {
    try {
      const content: string = fs.readFileSync(
        "/proc/sys/kernel/yama/ptrace_scope",
        "utf-8",
      );
      const value: number = parseInt(content.trim(), 10);

      return value === 0 || value === 1;
    } catch {
      return false;
    }
  }

  private _parseStraceOutput(handleId: string, output: string): void {
    const entry: IDetectorEntry | undefined = this._detectors.get(handleId);

    if (!entry || !entry.isActive) {
      return;
    }

    const lines: string[] = output.split("\n");

    for (const line of lines) {
      if (this._isStdinBlocked(line)) {
        this._logger.debug("Stdin block detected", {
          handleId,
          pid: entry.pid,
          line: line.substring(0, 100),
        });

        if (entry.onStdinBlocked) {
          entry.onStdinBlocked();
        }

        void this.stopAsync(handleId);
        return;
      }
    }
  }

  private _isStdinBlocked(line: string): boolean {
    const trimmedLine: string = line.trim();

    if (trimmedLine.length === 0 || trimmedLine.startsWith("---")) {
      return false;
    }

    if (this._isUnfinishedRead(trimmedLine)) {
      return true;
    }

    if (this._isBlockedPollWithFd0(trimmedLine)) {
      return true;
    }

    if (this._isBlockedSelectWithFd0(trimmedLine)) {
      return true;
    }

    if (this._isCompletedReadWithEagain(trimmedLine)) {
      return true;
    }

    return false;
  }

  private _isUnfinishedRead(line: string): boolean {
    return line.includes("read(0,") && line.includes("<unfinished");
  }

  private _isBlockedPollWithFd0(line: string): boolean {
    const hasPollCall: boolean =
      line.includes("poll([{fd=0") ||
      line.includes("ppoll([{fd=0") ||
      (line.includes("poll(") && line.includes("fd=0"));

    if (!hasPollCall) {
      return false;
    }

    const hasBlockedIndicator: boolean =
      line.includes("= 1") ||
      line.includes("= 2") ||
      line.includes("left=") ||
      line.includes("timeout=");

    return hasBlockedIndicator && !line.includes("= 0");
  }

  private _isBlockedSelectWithFd0(line: string): boolean {
    const hasSelectCall: boolean =
      line.includes("select(") ||
      line.includes("pselect6(") ||
      line.includes("pselect(");

    if (!hasSelectCall) {
      return false;
    }

    const hasReadFdSet: boolean =
      line.includes("fd=0") ||
      line.includes("readfds") ||
      line.includes("0, 0, 0") ||
      line.includes("[0]");

    if (!hasReadFdSet) {
      return false;
    }

    const hasBlockedIndicator: boolean =
      line.includes("left=") ||
      line.includes("timeout=") ||
      line.includes("= 0");

    return hasBlockedIndicator;
  }

  private _isCompletedReadWithEagain(line: string): boolean {
    return (
      line.includes("read(0,") &&
      (line.includes("-1 EAGAIN") || line.includes("EAGAIN"))
    );
  }

  //#endregion Private methods
}
