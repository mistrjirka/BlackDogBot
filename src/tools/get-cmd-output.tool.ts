import { tool } from "ai";

import { getCmdOutputToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService } from "../services/command-process.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof getCmdOutputToolInputSchema>;

export const getCmdOutputTool = tool({
  description: "Get the output (stdout/stderr) of a running command. Use the handleId returned by a previous run_cmd call.",
  inputSchema: getCmdOutputToolInputSchema,
  execute: async ({ handleId, channel, maxBytes }: IInput): Promise<Record<string, unknown>> => {
    const processService: CommandProcessService = CommandProcessService.getInstance();
    const status = processService.getStatus(handleId);

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
