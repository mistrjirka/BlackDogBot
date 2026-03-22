import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";

import { runCmdToolInputSchema, runCmdToolOutputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { CommandProcessService, type ProcessStatus } from "../services/command-process.service.js";
import { CommandDetectorLinuxService } from "../services/command-detector-linux.service.js";
import { getBaseDir } from "../utils/paths.js";
import type { z } from "zod";

type IRunCmdInput = z.infer<typeof runCmdToolInputSchema>;
type IRunCmdOutput = z.infer<typeof runCmdToolOutputSchema>;

const INTERACTIVE_PROMPT_PATTERNS: RegExp[] = [
  /\[sudo\].*[: ]*$/im,
  /password:\s*$/im,
  /heslo[: ]*$/im,
  /je vyzadovano heslo/i,
  /je vyžadováno heslo/i,
  /are you sure.*\[y\/n\]/i,
  /do you want to continue.*\[y\/n\]/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /passphrase:\s*$/im,
];

const IDLE_PROMPT_DETECTION_MS: number = 3000;

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

    const normalizedCommand: string = _normalizeInteractiveCommand(command, deterministicInputDetection);
    const childEnv: NodeJS.ProcessEnv = await _buildChildEnvAsync(normalizedCommand, deterministicInputDetection);

    if (normalizedCommand !== command) {
      logger.info("run_cmd command normalized for interactive stdin", {
        originalCommand: command,
        normalizedCommand,
      });
    }

    logger.info("run_cmd starting", {
      command: normalizedCommand,
      cwd: resolvedCwd,
      timeout,
      mode,
      deterministicInputDetection,
    });

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
      normalizedCommand,
      resolvedCwd,
      timeout,
      childEnv,
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
    let detectorHandleId: string = "";
    let heuristicInputDetectionUsed: boolean = false;

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
        const detectorError: string = startResult.error ?? "Unknown detector error";

        logger.warn("run_cmd deterministic detector unavailable, continuing without detector", {
          handleId,
          pid,
          error: detectorError,
        });
      }
    }

    // Wait for process to complete or enter awaiting_input state
    await new Promise<void>((resolve): void => {
      let lastStdoutLength: number = 0;
      let lastStderrLength: number = 0;
      let lastOutputAt: number = Date.now();

      const checkInterval: ReturnType<typeof setInterval> = setInterval((): void => {
        const currentStatus: ProcessStatus = processService.getStatus(handleId).status;
        const stdoutTail: string = processService.getOutput(handleId, "stdout", 4096).data;
        const stderrTail: string = processService.getOutput(handleId, "stderr", 4096).data;

        if (stdoutTail.length !== lastStdoutLength || stderrTail.length !== lastStderrLength) {
          lastStdoutLength = stdoutTail.length;
          lastStderrLength = stderrTail.length;
          lastOutputAt = Date.now();
        }

        if (
          deterministicInputDetection &&
          !detectorAvailable &&
          !heuristicInputDetectionUsed &&
          currentStatus === "running"
        ) {
          const combinedTail: string = `${stdoutTail}\n${stderrTail}`;

          if (_looksLikeInteractivePrompt(command, combinedTail)) {
            processService.onStdinBlocked(handleId);
            heuristicInputDetectionUsed = true;
            logger.info("run_cmd heuristic stdin prompt detected, switching to awaiting_input", {
              handleId,
              command: normalizedCommand,
            });
          } else if (_isLikelyInteractiveCommand(normalizedCommand) && Date.now() - lastOutputAt >= IDLE_PROMPT_DETECTION_MS) {
            processService.onStdinBlocked(handleId);
            heuristicInputDetectionUsed = true;
            logger.info("run_cmd heuristic idle stdin wait detected, switching to awaiting_input", {
              handleId,
              command: normalizedCommand,
              idleMs: Date.now() - lastOutputAt,
            });
          }
        }

        const effectiveStatus: ProcessStatus = processService.getStatus(handleId).status;

        if (effectiveStatus !== "running") {
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
        deterministic: detectorAvailable,
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

function _looksLikeInteractivePrompt(command: string, stderrOutput: string): boolean {
  if (!command.toLowerCase().includes("sudo")) {
    return false;
  }

  return INTERACTIVE_PROMPT_PATTERNS.some((pattern: RegExp): boolean => pattern.test(stderrOutput));
}

function _isLikelyInteractiveCommand(command: string): boolean {
  return /\b(sudo|su|ssh|passwd|login|ftp|sftp)\b/i.test(command);
}

function _normalizeInteractiveCommand(command: string, deterministicInputDetection: boolean): string {
  if (!deterministicInputDetection || !/\bsudo\b/i.test(command)) {
    return command;
  }

  // Keep command semantics intact, but force sudo askpass mode.
  // This allows stdin-provided passwords via run_cmd_input without requiring the model
  // to explicitly write "-A" each time.
  return command.replace(/\bsudo\b(?![^\n]*\s-(A|S)(\s|$))/gi, "sudo -A");
}

async function _buildChildEnvAsync(command: string, deterministicInputDetection: boolean): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (!deterministicInputDetection || !/\bsudo\b/i.test(command)) {
    return env;
  }

  if (!env.SUDO_ASKPASS) {
    const askpassPath: string = await _ensureAskpassScriptAsync();
    env.SUDO_ASKPASS = askpassPath;
  }

  return env;
}

async function _ensureAskpassScriptAsync(): Promise<string> {
  const scriptPath: string = path.join(getBaseDir(), "run-cmd-askpass.sh");

  const scriptContent: string = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "IFS= read -r password || true",
    "printf \"%s\" \"${password}\"",
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, scriptContent, { encoding: "utf-8", mode: 0o700 });
  await fs.chmod(scriptPath, 0o700);

  return scriptPath;
}
