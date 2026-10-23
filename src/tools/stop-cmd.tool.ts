import { tool } from "ai";

import { stopCmdToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService } from "../services/command-process.service.js";
import { LoggerService } from "../services/logger.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof stopCmdToolInputSchema>;

export const stopCmdTool = tool({
  description: "Stop a running command and its current child processes with SIGTERM, SIGKILL, or SIGINT. Waits for cleanup and output drain, escalating after 5 seconds. The handle remains available for final output/status until wait_for_cmd collects it. Use the handleId returned by a previous run_cmd call.",
  inputSchema: stopCmdToolInputSchema,
  execute: async ({ handleId, signal }: IInput): Promise<Record<string, unknown>> => {
    const logger: LoggerService = LoggerService.getInstance();
    const processService: CommandProcessService = CommandProcessService.getInstance();

    logger.info("stop_cmd stopping process", { handleId, signal });

    const result = await processService.stopAsync(
      handleId,
      signal,
    );

    const status = processService.getStatus(handleId);

    return {
      success: result.success,
      status: status.status,
      exitCode: status.exitCode,
      error: result.error ?? null,
    };
  },
});
