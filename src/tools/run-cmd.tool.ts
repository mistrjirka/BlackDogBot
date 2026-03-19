import os from "node:os";

import { tool } from "ai";

import { runCmdToolInputSchema, runCmdToolOutputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { CommandProcessService, type ProcessStatus } from "../services/command-process.service.js";
import { CommandDetectorLinuxService } from "../services/command-detector-linux.service.js";
import { getBaseDir } from "../utils/paths.js";
import type { z } from "zod";

type IRunCmdInput = z.infer<typeof runCmdToolInputSchema>;
type IRunCmdOutput = z.infer<typeof runCmdToolOutputSchema>;

export const runCmdTool = tool({
  description: "Execute a shell command and return stdout, stderr, and exit code.",
  inputSchema: runCmdToolInputSchema,
  execute: async ({ command, cwd, timeout, mode, deterministicInputDetection }: IRunCmdInput): Promise<IRunCmdOutput> => {
    const logger: LoggerService = LoggerService.getInstance();
    const processService: CommandProcessService = CommandProcessService.getInstance();
    const detector: CommandDetectorLinuxService = CommandDetectorLinuxService.getInstance();

    const resolvedCwd: string = cwd.startsWith("~")
      ? cwd.replace("~", os.homedir())
      : cwd || getBaseDir();

    logger.info("run_cmd starting", { command, cwd: resolvedCwd, timeout, mode, deterministicInputDetection });

    // Strict mode pre-checks
    if (deterministicInputDetection) {
      if (process.platform !== "linux") {
        return {
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "failed",
          handleId: null,
          timedOut: false,
          durationMs: null,
          signal: null,
          deterministic: false,
          error: "Deterministic stdin detection is only available on Linux.",
        };
      }
    }

    // Start the process
    const startTime: number = Date.now();
    const { handleId, child } = await processService.spawnProcessAsync(
      command,
      resolvedCwd,
      timeout,
    );

    const pid: number | undefined = child.pid;

    // Background mode: return immediately
    if (mode === "background") {
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        status: "running",
        handleId,
        timedOut: false,
        durationMs: null,
        signal: null,
        deterministic: false,
        error: null,
      };
    }

    // Foreground mode
    let detectorAvailable: boolean = false;
    let detectorError: string | null = null;
    let detectorHandleId: string = "";

    if (deterministicInputDetection && pid) {
      // Start detector with per-handle callback
      const startResult = await detector.startAsync(pid, (): void => {
        processService.onStdinBlocked(handleId);
        logger.info("run_cmd deterministic stdin block detected", { handleId, pid });
      });

      if (startResult.available) {
        detectorAvailable = true;
        detectorHandleId = startResult.handleId;
      } else {
        detectorError = startResult.error ?? "Unknown detector error";
        logger.warn("run_cmd deterministic detector unavailable", { handleId, pid, error: detectorError });

        // Strict mode: fail immediately — do not allow fallback
        processService.stopAsync(handleId).catch((): void => {});
        processService.removeHandle(handleId);

        return {
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "failed",
          handleId: null,
          timedOut: false,
          durationMs: Date.now() - startTime,
          signal: null,
          deterministic: false,
          error: `Deterministic stdin detection unavailable: ${detectorError}`,
        };
      }
    }

    // Wait for process to complete or enter awaiting_input state
    await new Promise<void>((resolve): void => {
      const checkInterval: ReturnType<typeof setInterval> = setInterval((): void => {
        const currentStatus: ProcessStatus = processService.getStatus(handleId).status;

        if (currentStatus !== "running") {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });

    // Stop detector if still running
    if (detectorAvailable && detectorHandleId) {
      await detector.stopAsync(detectorHandleId);
    }

    const durationMs: number = Date.now() - startTime;
    const finalStatus: ProcessStatus = processService.getStatus(handleId).status;
    const entryStatus = processService.getStatus(handleId);

    // Collect output
    const stdoutResult: string = processService.getOutput(handleId, "stdout", 65536).data;
    const stderrResult: string = processService.getOutput(handleId, "stderr", 65536).data;

    // Build result based on final status
    if (finalStatus === "awaiting_input") {
      return {
        stdout: stdoutResult,
        stderr: stderrResult,
        exitCode: null,
        status: "awaiting_input",
        handleId,
        timedOut: false,
        durationMs,
        signal: null,
        deterministic: true,
        error: null,
      };
    }

    // Terminal statuses — cleanup handle
    processService.removeHandle(handleId);

    if (finalStatus === "timed_out") {
      return {
        stdout: stdoutResult,
        stderr: stderrResult,
        exitCode: entryStatus.exitCode,
        status: "timed_out",
        handleId: null,
        timedOut: true,
        durationMs,
        signal: entryStatus.signal,
        deterministic: detectorAvailable,
        error: null,
      };
    }

    if (finalStatus === "killed") {
      return {
        stdout: stdoutResult,
        stderr: stderrResult,
        exitCode: entryStatus.exitCode,
        status: "killed",
        handleId: null,
        timedOut: false,
        durationMs,
        signal: entryStatus.signal,
        deterministic: detectorAvailable,
        error: null,
      };
    }

    if (finalStatus === "failed") {
      return {
        stdout: stdoutResult,
        stderr: stderrResult,
        exitCode: entryStatus.exitCode ?? 1,
        status: "failed",
        handleId: null,
        timedOut: false,
        durationMs,
        signal: entryStatus.signal,
        deterministic: detectorAvailable,
        error: entryStatus.error,
      };
    }

    // completed
    return {
      stdout: stdoutResult,
      stderr: stderrResult,
      exitCode: entryStatus.exitCode ?? 0,
      status: "completed",
      handleId: null,
      timedOut: false,
      durationMs,
      signal: null,
      deterministic: detectorAvailable,
      error: null,
    };
  },
});
