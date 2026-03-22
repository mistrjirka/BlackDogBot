import fs from "node:fs/promises";

import { tool } from "ai";

import { writeFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { type IFileReadTracker } from "../utils/file-tools-helper.js";
import { runFileOperationAsync } from "../utils/file-operation-helper.js";

//#region Interfaces

interface IWriteFileResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Factory

export function createWriteFileTool(readTracker: IFileReadTracker) {
  return tool({
    description:
      "Write content to a file, completely replacing its contents. " +
      "IMPORTANT: You MUST read the file with read_file first before overwriting it. " +
      "If the file does not exist yet, you can write to it without reading first. " +
      "The default location is the workspace directory (~/.blackdogbot/workspace/). " +
      "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
      "Only specify an absolute path when accessing files outside the workspace.",
    inputSchema: writeFileToolInputSchema,
    execute: async ({ filePath, content }: { filePath: string; content: string }): Promise<IWriteFileResult> => {
      const logger: LoggerService = LoggerService.getInstance();

      const operationResult = await runFileOperationAsync<IWriteFileResult>({
        logger,
        filePath,
        onErrorLogMessage: "File write failed",
        runAsync: async (resolvedPath: string): Promise<IWriteFileResult> => {
          let fileExists: boolean;

          try {
            await fs.access(resolvedPath);
            fileExists = true;
          } catch {
            fileExists = false;
          }

          if (fileExists && !readTracker.hasBeenRead(resolvedPath)) {
            return {
              success: false,
              message: `You must read the file "${filePath}" with read_file before overwriting it. This prevents accidental data loss.`,
            };
          }

          await fs.writeFile(resolvedPath, content, "utf-8");
          readTracker.markRead(resolvedPath);

          return { success: true, message: `File written successfully (${content.length} characters).` };
        },
      });

      if (!operationResult.success) {
        return { success: false, message: operationResult.errorMessage };
      }

      if (!operationResult.value.success) {
        return operationResult.value;
      }

      logger.debug("File written successfully", {
        path: operationResult.resolvedPath,
        size: content.length,
      });

      return operationResult.value;
    },
  });
}

//#endregion Factory
