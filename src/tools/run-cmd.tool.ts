import os from "node:os";
import { tool } from "ai";
import { runCmdToolInputSchema, runCmdToolOutputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { CommandProcessService, type ProcessStatus } from "../services/command-process.service.js";
import { getBaseDir } from "../utils/paths.js";
import type { z } from "zod";

type IRunCmdInput = z.infer<typeof runCmdToolInputSchema>;
type IRunCmdOutput = z.infer<typeof runCmdToolOutputSchema>;
const OUTPUT_LIMIT = 65536;
const PROMPT_CHECK_INTERVAL_MS = 75;

// Heuristic only: an interactive program need not emit a detectable prompt.
function looksLikeInputPrompt(output: string): boolean {
  const lastLine = output.split(/[\r\n]/).at(-1)?.trimEnd() ?? "";
  return /(?:password|passphrase|verification code|enter .{0,40}|continue|confirm|choice|select)\s*[:?]\s*$/i.test(lastLine) ||
    /(?:\[y\/N\]|\[Y\/n\]|\(yes\/no\))\s*$/i.test(lastLine);
}

export const runCmdTool = tool({
  description: "Execute a shell command in a real PTY terminal. Files persist across commands; running processes stay reachable via handleId until completion or bot restart. PTY merges command stdout/stderr into stdout, with wrapper errors in stderr. Use foreground for short commands, background for interactive or long-running commands; use run_cmd_input to send subsequent text or raw keys. Execution timeout includes time spent thinking between calls. Use timeout=0 and stop_cmd for input/stop-controlled sessions. Commands cannot access BlackDogBot's per-run blackboard variables.",
  inputSchema: runCmdToolInputSchema,
  execute: async ({ command, cwd, timeout, mode }: IRunCmdInput): Promise<IRunCmdOutput> => {
    const logger = LoggerService.getInstance();
    const service = CommandProcessService.getInstance();
    const resolvedCwd = cwd.startsWith("~") ? cwd.replace("~", os.homedir()) : cwd || getBaseDir();
    logger.info("run_cmd starting", { commandLength: command.length, cwd: resolvedCwd, timeout, mode });
    const start = Date.now();
    const executionTimeout = timeout ?? (mode === "background" ? 600_000 : 30_000);
    const { handleId } = await service.spawnProcessAsync(command, resolvedCwd, executionTimeout, {
      ...process.env, TERM: process.env.TERM || "xterm-256color",
    });
    if (mode === "background") {
      return {
        stdout: "", stderr: "", exitCode: null, status: "running", handleId,
        timedOut: false, durationMs: null, signal: null, error: null,
      };
    }
    await new Promise<void>((resolve) => {
      let prompted = false;
      let lastOutput = "";
      let lastOutputAt = Date.now();
      const interval = setInterval(() => {
        const status: ProcessStatus = service.getStatus(handleId).status;
        const output = service.getOutput(handleId, "stdout", 4096).data;
        if (output !== lastOutput) {
          lastOutput = output;
          lastOutputAt = Date.now();
        }
        if (status === "running" && !prompted && Date.now() - lastOutputAt > 150 &&
            looksLikeInputPrompt(lastOutput)) {
          service.onStdinBlocked(handleId);
          prompted = true;
        }
        if (service.getStatus(handleId).status !== "running") {
          clearInterval(interval);
          resolve();
        }
      }, PROMPT_CHECK_INTERVAL_MS);
    });
    const finalStatus = service.getStatus(handleId);
    const stdout = service.getOutput(handleId, "stdout", OUTPUT_LIMIT).data;
    const stderr = service.getOutput(handleId, "stderr", OUTPUT_LIMIT).data;
    const running = finalStatus.status === "awaiting_input" || finalStatus.status === "running";
    if (!running) service.removeHandle(handleId);
    return {
      stdout, stderr, exitCode: finalStatus.exitCode, status: finalStatus.status,
      handleId: running ? handleId : null,
      timedOut: finalStatus.status === "timed_out",
      durationMs: Date.now() - start, signal: finalStatus.signal,
      error: finalStatus.error,
    };
  },
});
