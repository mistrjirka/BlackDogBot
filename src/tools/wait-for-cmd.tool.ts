import { tool } from "ai";

import { waitForCmdToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService, type ProcessStatus } from "../services/command-process.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof waitForCmdToolInputSchema>;

const terminalStatuses: Set<ProcessStatus> = new Set(["completed", "failed", "timed_out", "killed"]);
const pollIntervalMs: number = 100;

export const waitForCmdTool = tool({
  description: "Wait for a running command to finish (or await input) and return final status plus output.",
  inputSchema: waitForCmdToolInputSchema,
  execute: async ({ handleId, timeoutMs, maxBytes }: IInput): Promise<Record<string, unknown>> => {
    const processService: CommandProcessService = CommandProcessService.getInstance();
    const waitStartAt: number = Date.now();

    let waitTimedOut: boolean = false;

    while (true) {
      const currentStatus = processService.getStatus(handleId);

      if (terminalStatuses.has(currentStatus.status) || currentStatus.status === "awaiting_input") {
        break;
      }

      if (Date.now() - waitStartAt >= timeoutMs) {
        waitTimedOut = true;
        break;
      }

      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, pollIntervalMs);
      });
    }

    const finalStatus = processService.getStatus(handleId);
    const stdoutResult = processService.getOutput(handleId, "stdout", maxBytes);
    const stderrResult = processService.getOutput(handleId, "stderr", maxBytes);
    const completed: boolean = terminalStatuses.has(finalStatus.status);

    if (completed) {
      processService.removeHandle(handleId);
    }

    return {
      handleId,
      completed,
      status: finalStatus.status,
      exitCode: finalStatus.exitCode,
      signal: finalStatus.signal,
      stdout: stdoutResult.data,
      stderr: stderrResult.data,
      stdoutBytes: finalStatus.stdoutBytes,
      stderrBytes: finalStatus.stderrBytes,
      timedOut: finalStatus.status === "timed_out",
      waitTimedOut,
      error: finalStatus.error,
    };
  },
});
