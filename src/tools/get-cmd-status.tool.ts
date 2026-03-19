import { tool } from "ai";

import { getCmdStatusToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService } from "../services/command-process.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof getCmdStatusToolInputSchema>;

export const getCmdStatusTool = tool({
  description: "Get the current status of a running command. Use the handleId returned by a previous run_cmd call.",
  inputSchema: getCmdStatusToolInputSchema,
  execute: async ({ handleId }: IInput): Promise<Record<string, unknown>> => {
    const processService: CommandProcessService = CommandProcessService.getInstance();
    const status = processService.getStatus(handleId);

    return {
      handleId,
      status: status.status,
      pid: status.pid,
      exitCode: status.exitCode,
      startedAt: status.startedAt,
      elapsedMs: status.durationMs ?? 0,
      stdoutBytes: status.stdoutBytes,
      stderrBytes: status.stderrBytes,
      timedOut: status.status === "timed_out",
      signal: status.signal,
      error: status.error,
    };
  },
});
