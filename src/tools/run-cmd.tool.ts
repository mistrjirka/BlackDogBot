import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { tool } from "ai";

import { runCmdToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { getBaseDir } from "../utils/paths.js";

interface IRunCmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const _execAsync = promisify(exec);

export const runCmdTool = tool({
  description: "Execute a shell command and return stdout, stderr, and exit code.",
  inputSchema: runCmdToolInputSchema,
  execute: async ({
    command,
    cwd,
    timeout,
  }: {
    command: string;
    cwd: string;
    timeout: number;
  }): Promise<IRunCmdResult> => {
    const resolvedCwd: string = cwd.startsWith("~")
      ? cwd.replace("~", os.homedir())
      : cwd || getBaseDir();

    LoggerService.getInstance().debug(`Running command: ${command}`, { cwd: resolvedCwd, timeout });

    try {
      const { stdout, stderr } = await _execAsync(command, {
        cwd: resolvedCwd,
        timeout,
      });

      return { stdout, stderr, exitCode: 0 };
    } catch (error: unknown) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
      };

      return {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? "",
        exitCode: execError.code ?? 1,
      };
    }
  },
});
