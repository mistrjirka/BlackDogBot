import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "langchain";

import {
  thinkToolInputSchema,
  readFileToolInputSchema,
  writeFileToolInputSchema,
  runCmdToolInputSchema,
  runCmdToolOutputSchema,
  searchKnowledgeToolInputSchema,
} from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { ThinkOperationTracker } from "../utils/think-limit.js";
import { FileReadTracker } from "../utils/file-tools-helper.js";
import { runFileOperationAsync } from "../utils/file-operation-helper.js";
import { CommandProcessService, type ProcessStatus } from "../services/command-process.service.js";
import { CommandDetectorLinuxService } from "../services/command-detector-linux.service.js";
import { getBaseDir } from "../utils/paths.js";
import * as knowledge from "../helpers/knowledge.js";
import type { IKnowledgeSearchResult, IKnowledgeSearchOptions } from "../shared/types/index.js";
import type { z } from "zod";

type IRunCmdInput = z.infer<typeof runCmdToolInputSchema>;
type IRunCmdOutput = z.infer<typeof runCmdToolOutputSchema>;

// ============================================================================
// Think Tool
// ============================================================================

// Global tracker instance for the application
const thinkTracker = new ThinkOperationTracker({
  maxThinkOperations: 30,
  maxTotalThinkCharacters: 100000,
  maxSingleThoughtLength: 3000,
});

export const thinkTool = tool(
  async ({ thought }: { thought: string }): Promise<{ acknowledged: boolean }> => {
    const logger = LoggerService.getInstance();

    // Record the think operation and check limits
    const { thought: processedThought, wasTruncated } = thinkTracker.recordThinkOperation(thought);

    const thoughtLength = processedThought.length;
    const estimatedTokens = Math.ceil(thoughtLength / 4); // Rough estimate: ~4 chars per token

    logger.info("Thinking operation executed", {
      thoughtLength,
      estimatedTokens,
      wasTruncated,
      thoughtPreview: processedThought.substring(0, Math.min(200, thoughtLength)) +
        (thoughtLength > 200 ? "..." : ""),
    });

    return { acknowledged: true };
  },
  {
    name: "think",
    description: "Use this to think through a problem step by step before acting.",
    schema: thinkToolInputSchema,
  },
);

// Export the tracker for resetting between tasks
export { thinkTracker };

// ============================================================================
// Read File Tool
// ============================================================================

// Create a shared tracker for file tools
const fileReadTracker = new FileReadTracker();

interface IReadFileResult {
  success: boolean;
  content: string | undefined;
  message: string;
}

export const readFileTool = tool(
  async ({ filePath }: { filePath: string }): Promise<IReadFileResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    const operationResult = await runFileOperationAsync<string>({
      logger,
      filePath,
      onErrorLogMessage: "File read failed",
      runAsync: async (resolvedPath: string): Promise<string> => {
        const content: string = await fs.readFile(resolvedPath, "utf-8");
        fileReadTracker.markRead(resolvedPath);
        return content;
      },
    });

    if (!operationResult.success) {
      const errorMsg = (operationResult as { success: false; errorMessage: string }).errorMessage;
      return { success: false, content: undefined, message: errorMsg };
    }

    logger.debug("File read successfully", {
      path: operationResult.resolvedPath,
      size: operationResult.value.length,
    });

    return {
      success: true,
      content: operationResult.value,
      message: `File read successfully (${operationResult.value.length} characters).`,
    };
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file. The default location is the workspace directory (~/.blackdogbot/workspace/). " +
      "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
      "Only specify an absolute path when accessing files outside the workspace.",
    schema: readFileToolInputSchema,
  },
);

// Export the tracker for external use
export { fileReadTracker };

// ============================================================================
// Write File Tool
// ============================================================================

interface IWriteFileResult {
  success: boolean;
  message: string;
}

export const writeFileTool = tool(
  async ({ filePath, content }: { filePath: string; content: string }): Promise<IWriteFileResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    const operationResult = await runFileOperationAsync<IWriteFileResult>({
      logger,
      filePath,
      onErrorLogMessage: "File write failed",
      runAsync: async (resolvedPath: string): Promise<IWriteFileResult> => {
        let fileExists: boolean;

        try {
          await fs.access(resolvedPath);
          fileExists = true;
        } catch {
          fileExists = false;
        }

        if (fileExists && !fileReadTracker.hasBeenRead(resolvedPath)) {
          return {
            success: false,
            message: `You must read the file "${filePath}" with read_file before overwriting it. This prevents accidental data loss.`,
          };
        }

        await fs.writeFile(resolvedPath, content, "utf-8");
        fileReadTracker.markRead(resolvedPath);

        return { success: true, message: `File written successfully (${content.length} characters).` };
      },
    });

    if (!operationResult.success) {
      const errorMsg = (operationResult as { success: false; errorMessage: string }).errorMessage;
      return { success: false, message: errorMsg };
    }

    if (!operationResult.value.success) {
      return operationResult.value;
    }

    logger.debug("File written successfully", {
      path: operationResult.resolvedPath,
      size: content.length,
    });

    return operationResult.value;
  },
  {
    name: "write_file",
    description:
      "Write content to a file, completely replacing its contents. " +
      "IMPORTANT: You MUST read the file with read_file first before overwriting it. " +
      "If the file does not exist yet, you can write to it without reading first. " +
      "The default location is the workspace directory (~/.blackdogbot/workspace/). " +
      "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
      "Only specify an absolute path when accessing files outside the workspace.",
    schema: writeFileToolInputSchema,
  },
);

// ============================================================================
// Run Command Tool
// ============================================================================

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

export const runCmdTool = tool(
  async ({ command, cwd, timeout, mode, deterministicInputDetection }: IRunCmdInput): Promise<IRunCmdOutput> => {
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
  {
    name: "run_cmd",
    description: "Execute a shell command and return stdout, stderr, and exit code.",
    schema: runCmdToolInputSchema,
  },
);

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

// ============================================================================
// Search Knowledge Tool
// ============================================================================

export const searchKnowledgeTool = tool(
  async ({ query, collection, limit }: { query: string; collection: string; limit: number }): Promise<{ results: Array<{ id: string; content: string; score: number; metadata: Record<string, unknown> }> }> => {
    const options: IKnowledgeSearchOptions = { query, collection, limit, filter: null };
    const results: IKnowledgeSearchResult[] = await knowledge.searchKnowledgeAsync(options);

    return {
      results: results.map((r: IKnowledgeSearchResult) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        metadata: r.metadata,
      })),
    };
  },
  {
    name: "search_knowledge",
    description: "Search the knowledge base for relevant information. Returns matching documents ranked by relevance.",
    schema: searchKnowledgeToolInputSchema,
  },
);
