import { tool } from "ai";

import { getCmdOutputToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService } from "../services/command-process.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof getCmdOutputToolInputSchema>;

export const getCmdOutputTool = tool({
  description: "Read cumulative PTY output for handleId; repeated reads may contain previous text. Program stdout and stderr are merged into stdout; wrapper errors use stderr. Unknown handles return an error.",
  inputSchema: getCmdOutputToolInputSchema,
  execute: async ({ handleId, channel, maxBytes }: IInput): Promise<Record<string, unknown>> => {
    const processService: CommandProcessService = CommandProcessService.getInstance();
    const status = processService.getStatus(handleId);
    if (!processService.getEntry(handleId)) {
      return { handleId, status: "failed", error: status.error, stdout: "", stderr: "", totalStdoutBytes: 0, totalStderrBytes: 0 };
    }

    let stdout: string = "";
    let stderr: string = "";

    if (channel === "stdout" || channel === "both") {
      const result = processService.getOutput(handleId, "stdout", maxBytes);
      stdout = result.data;
    }

    if (channel === "stderr" || channel === "both") {
      const result = processService.getOutput(handleId, "stderr", maxBytes);
      stderr = result.data;
    }

    return {
      handleId,
      stdout,
      stderr,
      totalStdoutBytes: status.stdoutBytes,
      totalStderrBytes: status.stderrBytes,
    };
  },
});
