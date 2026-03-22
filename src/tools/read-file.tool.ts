import fs from "node:fs/promises";

import { tool } from "ai";

import { readFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { type IFileReadTracker } from "../utils/file-tools-helper.js";
import { runFileOperationAsync } from "../utils/file-operation-helper.js";

//#region Interfaces

interface IReadFileResult {
  success: boolean;
  content: string | undefined;
  message: string;
}

//#endregion Interfaces

//#region Factory

export function createReadFileTool(readTracker: IFileReadTracker) {
  return tool({
    description:
      "Read the contents of a file. The default location is the workspace directory (~/.blackdogbot/workspace/). " +
      "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
      "Only specify an absolute path when accessing files outside the workspace.",
    inputSchema: readFileToolInputSchema,
    execute: async ({ filePath }: { filePath: string }): Promise<IReadFileResult> => {
      const logger: LoggerService = LoggerService.getInstance();

      const operationResult = await runFileOperationAsync<string>({
        logger,
        filePath,
        onErrorLogMessage: "File read failed",
        runAsync: async (resolvedPath: string): Promise<string> => {
          const content: string = await fs.readFile(resolvedPath, "utf-8");
          readTracker.markRead(resolvedPath);
          return content;
        },
      });

      if (!operationResult.success) {
        return { success: false, content: undefined, message: operationResult.errorMessage };
      }

      logger.debug("File read successfully", {
        path: operationResult.resolvedPath,
        size: operationResult.value.length,
      });

      return {
        success: true,
        content: operationResult.value,
        message: `File read successfully (${operationResult.value.length} characters).`,
      };
    },
  });
}

//#endregion Factory
