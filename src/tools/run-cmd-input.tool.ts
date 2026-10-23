import { tool } from "ai";

import { runCmdInputToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { CommandProcessService } from "../services/command-process.service.js";
import { LoggerService } from "../services/logger.service.js";
import type { z } from "zod";

type IInput = z.infer<typeof runCmdInputToolInputSchema>;

const CONTROL_KEYS: Record<NonNullable<IInput["controlKey"]>, string> = {
  CTRL_C: String.fromCharCode(3),
  CTRL_D: String.fromCharCode(4),
  CTRL_U: String.fromCharCode(21),
  TAB: String.fromCharCode(9),
  ENTER: String.fromCharCode(13),
  ESCAPE: String.fromCharCode(27),
  DELETE: String.fromCharCode(27) + "[3~",
};

export const runCmdInputTool = tool({
  description: "Send a decoded input string or use controlKey for special keys (CTRL_C, TAB, etc). Provide exactly one. Special keys never add a newline. Wait for application readiness after starting background commands. Terminal echo is not proof the program read input.",
  inputSchema: runCmdInputToolInputSchema,
  execute: async ({ handleId, input, controlKey, appendNewline, closeStdin }: IInput): Promise<Record<string, unknown>> => {
    const logger: LoggerService = LoggerService.getInstance();
    const processService: CommandProcessService = CommandProcessService.getInstance();

    logger.info("run_cmd_input sending input", { handleId, inputLength: input?.length ?? 0, controlKey, closeStdin });

    try {
      if ((input === undefined) === (controlKey === undefined)) {
        throw new Error("Provide exactly one of input or controlKey");
      }
      if (controlKey !== undefined && closeStdin) {
        throw new Error("controlKey and closeStdin cannot be combined");
      }
      const text: string = controlKey === undefined ? input! : CONTROL_KEYS[controlKey];
      const finalInput: string = controlKey === undefined && appendNewline !== false && !text.endsWith("\n") ? text + "\n" : text;

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
        status: processService.getStatus(handleId).status,
        stdout: "",
        stderr: "",
        exitCode: null,
        error: errorMessage,
      };
    }
  },
});
