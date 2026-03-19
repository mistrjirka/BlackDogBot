import { tool } from "ai";

import { stopCmdToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService } from "../services/command-process.service.js";
import { LoggerService } from "../services/logger.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof stopCmdToolInputSchema>;

export const stopCmdTool = tool({
  description: "Stop a running command by sending a signal (SIGTERM, SIGKILL, SIGINT). Use the handleId returned by a previous run_cmd call.",
  inputSchema: stopCmdToolInputSchema,
  execute: async ({ handleId, signal }: IInput): Promise<Record<string, unknown>> => {
    const logger: LoggerService = LoggerService.getInstance();
    const processService: CommandProcessService = CommandProcessService.getInstance();

    logger.info("stop_cmd stopping process", { handleId, signal });

    const result = await processService.stopAsync(
      handleId,
      signal as "SIGTERM" | "SIGKILL" | "SIGINT",
    );

    const status = processService.getStatus(handleId);
    processService.removeHandle(handleId);

    return {
      success: result.success,
      status: status.status,
      exitCode: status.exitCode,
      error: result.error ?? null,
    };
  },
});
