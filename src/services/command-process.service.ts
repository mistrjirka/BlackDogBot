import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs/promises";

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
  termination?: Promise<void>;
  closed?: boolean;
  lastReadOffsetStdout: number;
  lastReadOffsetStderr: number;
  signal: string | null;
  exitCode: number | null;
  error: string | null;
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

    this._logger.debug("Spawning process", { handleId, commandLength: command.length, cwd, timeout });

    // util-linux script supplies one PTY for every command. The child sees a
    // genuine terminal; -e preserves its exit status and -f streams output.
    // Without a parent TTY, util-linux script starts with 0 rows / 0 cols.
    // Set a usable size before the requested program starts (no new tool mode).
    const terminalCommand: string = "stty rows 40 cols 120 2>/dev/null; " + command;
    const child: ChildProcess = spawn("script", ["-q", "-e", "-f", "-c", terminalCommand, "/dev/null"], {
      shell: false,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const stdout: Buffer = Buffer.alloc(0);
    const stderr: Buffer = Buffer.alloc(0);

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
    };

    // Input races with process exit can emit EPIPE on the stream even when
    // write's callback receives the error. Keep that race from crashing the bot.
    child.stdin?.on("error", (error: Error): void => {
      this._logger.debug("Process stdin closed", { handleId, error: error.message });
    });

    // Setup stdout handler
    child.stdout?.on("data", (data: Buffer): void => {
      entry.stdout = this._appendBuffer(entry.stdout, data);
    });

    // Setup stderr handler
    child.stderr?.on("data", (data: Buffer): void => {
      entry.stderr = this._appendBuffer(entry.stderr, data);
    });

    // Wait for the terminal's output pipes to drain before publishing status.
    child.on("close", (code: number | null, signal: string | null): void => {
      entry.closed = true;
      if (!entry.termination && (entry.status === "running" || entry.status === "awaiting_input")) {
        entry.status = code === 0 ? "completed" : "failed";
      }
      entry.exitCode = code;
      entry.signal = signal;

      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }

      this._logger.debug("Process exited", { handleId, exitCode: code, signal });
    });

    // Setup error handler
    child.on("error", (error: Error): void => {
      entry.error = error.message;
      entry.status = "failed";
      this._logger.error("Process error", { handleId, error: error.message });
    });

    // Store the entry
    this._processes.set(handleId, entry);

    // Start timeout timer
    if (timeout > 0) {
      entry.timeoutTimer = setTimeout((): void => {
        void this._terminateAsync(entry, "SIGTERM", "timed_out").catch((error: unknown) => {
          entry.error = error instanceof Error ? error.message : String(error);
          entry.status = "failed";
          this._logger.error("Process termination failed", { handleId, error: entry.error });
        });
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

    if (!["running", "awaiting_input"].includes(entry.status) || entry.termination || !entry.child.stdin?.writable || entry.child.stdin.destroyed) {
      throw new Error(`Process is not accepting input: ${handleId} (${entry.status})`);
    }

    const wasAwaitingInput = entry.status === "awaiting_input";
    const terminalInput = input + (closeStdin ? "\x04" : "");
    await new Promise<void>((resolve, reject) => {
      entry.child.stdin!.write(terminalInput, (error?: Error | null) => error ? reject(error) : resolve());
    });
    if (wasAwaitingInput && entry.status === "awaiting_input") entry.status = "running";

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
        status: "failed",
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

    if (!["running", "awaiting_input"].includes(entry.status) || entry.termination) {
      return { success: false, error: `Process already terminated or stopping: ${entry.status}` };
    }

    this._logger.info("Stopping process", { handleId, signal });
    try {
      await this._terminateAsync(entry, signal, "killed");
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
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

  private async _readProcessAsync(pid: number): Promise<{ pid: number; start: string; running: boolean } | null> {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      // The command name can contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { pid, start: fields[19], running: !["Z", "X"].includes(fields[0]) };
    } catch (error: unknown) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  }

  private async _collectProcessesAsync(rootPid: number): Promise<{ pid: number; start: string }[]> {
    const targets: { pid: number; start: string }[] = [];
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const identity = await this._readProcessAsync(pid);
      if (!identity) continue;
      targets.push(identity);
      try {
        // Children can be created by any thread, not only the thread-group leader.
        for (const tid of await fs.readdir(`/proc/${pid}/task`)) {
          try {
            const children = await fs.readFile(`/proc/${pid}/task/${tid}/children`, "utf8");
            queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
          } catch (error: unknown) {
            if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      } catch (error: unknown) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    return targets;
  }

  private async _terminateAsync(entry: IProcessEntry, signal: "SIGTERM" | "SIGKILL" | "SIGINT", status: "killed" | "timed_out"): Promise<void> {
    if (entry.termination) return entry.termination;
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.timeoutTimer = null;
    entry.termination = (async (): Promise<void> => {
      if (status === "timed_out") this._logger.warn("Process timed out", { handleId: entry.handleId });
      // script's PTY child has a separate process group. Killing only the
      // wrapper (especially with SIGKILL) does not reliably kill descendants.
      const targets = await this._collectProcessesAsync(entry.pid);
      const signalTargets = async (nextSignal: NodeJS.Signals): Promise<void> => {
        for (const target of [...targets].reverse()) {
          const current = await this._readProcessAsync(target.pid);
          // A recycled PID must never receive our cleanup signal.
          if (!current?.running || current.start !== target.start) continue;
          try { process.kill(target.pid, nextSignal); }
          catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      };
      await signalTargets(signal);
      const deadline = Date.now() + (signal === "SIGKILL" ? 1000 : TIMEOUT_GRACE_MS);
      while (Date.now() < deadline) {
        const live = await Promise.all(targets.map(async target => {
          const current = await this._readProcessAsync(target.pid);
          return current?.running && current.start === target.start;
        }));
        if (!live.some(Boolean) && entry.closed) break;
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      await signalTargets("SIGKILL");
      const killDeadline = Date.now() + 1000;
      while (true) {
        const live = await Promise.all(targets.map(async target => {
          const current = await this._readProcessAsync(target.pid);
          return current?.running && current.start === target.start;
        }));
        if (!live.some(Boolean)) break;
        if (Date.now() >= killDeadline) throw new Error("Child processes did not terminate after SIGKILL");
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      // Publish a terminal status only after the wrapper closes and pipes drain.
      if (!entry.closed) {
        await new Promise<void>(resolve => {
          if (entry.closed) return resolve();
          entry.child.once("close", () => resolve());
        });
      }
      entry.status = status;
    })();
    return entry.termination;
  }

  //#endregion Private methods
}
