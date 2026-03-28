import { tool } from "langchain";

import { runCmdInputToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService } from "../services/command-process.service.js";
import { LoggerService } from "../services/logger.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof runCmdInputToolInputSchema>;

export const runCmdInputTool = tool(
  async ({ handleId, input, closeStdin }: IInput): Promise<Record<string, unknown>> => {
    const logger: LoggerService = LoggerService.getInstance();
    const processService: CommandProcessService = CommandProcessService.getInstance();

    logger.info("run_cmd_input sending input", { handleId, inputLength: input.length, closeStdin });

    try {
      // Auto-append newline if not already present
      const finalInput: string = input.endsWith("\n") ? input : input + "\n";

      const result = await processService.sendInputAsync(handleId, finalInput, closeStdin);

      return {
        success: true,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: null,
        error: null,
      };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        status: "failed",
        stdout: "",
        stderr: "",
        exitCode: null,
        error: errorMessage,
      };
    }
  },
  {
    name: "run_cmd_input",
    description: "Send input to a running command that is waiting for stdin. Use the handleId returned by a previous run_cmd call. A newline is automatically appended.",
    schema: runCmdInputToolInputSchema,
  },
);
